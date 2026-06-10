/**
 * HuggingFace Hub client for dataset publication.
 * Token is read at runtime from the secrets provider — never hard-coded.
 */

import { secrets } from "../../governance/secrets.js"

async function getToken(): Promise<string> {
  return secrets.require("HF_PUBLISH_TOKEN")
}

const HF_API = "https://huggingface.co/api"

export async function commitFiles(
  repoId: string,
  operations: Array<{ op: string; path: string; content?: string }>,
  commitMessage: string,
  revision: string,
): Promise<{ sha: string }> {
  const token = await getToken()
  const res = await fetch(`${HF_API}/datasets/${repoId}/commit`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      operations,
      commit: { message: commitMessage },
      branch: revision,
    }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Failed to commit to ${repoId}/${revision}: ${res.status} ${text.slice(0, 500)}`)
  }
  return res.json() as Promise<{ sha: string }>
}

export async function getRemoteTree(
  repoId: string,
  revision: string,
): Promise<Array<{ path: string; sha: string; size: number; type: string }>> {
  const token = await getToken()
  const res = await fetch(
    `${HF_API}/datasets/${repoId}/tree/${revision}?recursive=true`,
    { headers: { Authorization: `Bearer ${token}` } },
  )
  if (!res.ok) throw new Error(`Failed to get tree for ${repoId}/${revision}: ${res.status}`)
  return res.json() as Promise<Array<{ path: string; sha: string; size: number; type: string }>>
}
