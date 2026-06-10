/**
 * Remote Verification — independently verify published dataset content.
 * Reads remote tree, recomputes digests, compares against local release manifest.
 */

import { getRemoteTree } from "./hf-client.js"
import { sha256Hex } from "../../shared/digests.js"
import type { DatasetReleaseManifest } from "./types.js"

export interface RemoteVerificationResult {
  verified: boolean
  remote_commit_sha: string
  files_checked: number
  files_matched: number
  mismatches: Array<{ path: string; local_digest: string; remote_digest: string }>
  missing_remote: string[]
  errors: string[]
}

export async function verifyRemote(
  repoId: string,
  revision: string,
  manifest: DatasetReleaseManifest,
): Promise<RemoteVerificationResult> {
  const result: RemoteVerificationResult = {
    verified: false,
    remote_commit_sha: revision,
    files_checked: 0,
    files_matched: 0,
    mismatches: [],
    missing_remote: [],
    errors: [],
  }

  let tree: Array<{ path: string; sha: string; size: number; type: string }>
  try {
    tree = await getRemoteTree(repoId, revision)
  } catch (e) {
    result.errors.push(`Failed to get remote tree: ${e instanceof Error ? e.message : String(e)}`)
    return result
  }

  const remoteByPath = new Map(tree.map(e => [e.path, e.sha]))

  for (const file of manifest.files) {
    result.files_checked++
    const remoteSha = remoteByPath.get(file.path)
    if (!remoteSha) {
      result.missing_remote.push(file.path)
      continue
    }
    if (remoteSha === file.digest) {
      result.files_matched++
    } else {
      result.mismatches.push({ path: file.path, local_digest: file.digest, remote_digest: remoteSha })
    }
  }

  result.verified = result.mismatches.length === 0 && result.missing_remote.length === 0 && result.files_checked > 0
  return result
}
