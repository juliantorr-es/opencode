/**
 * HuggingFace Hub client for dataset publication.
 * Token is read at runtime from the secrets provider — never hard-coded.
 */

import { secrets } from "../../governance/secrets.js";

function hfHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

const HF_API = "https://huggingface.co/api";

export interface HfRepoInfo {
  id: string;
  sha: string;
  default_branch: string;
}

export interface HfPrResponse {
  number: number;
  html_url: string;
  head: { ref: string; sha: string };
}

export async function getRepoInfo(repoId: string, repoType: string = "dataset"): Promise<HfRepoInfo> {
  const token = await secrets.require("HF_PUBLISH_TOKEN");
  const res = await fetch(`${HF_API}/${repoType}s/${repoId}`, { headers: hfHeaders(token) });
  if (!res.ok) throw new Error(`Failed to get repo info: ${res.status} ${await res.text()}`);
  return res.json() as Promise<HfRepoInfo>;
}

export async function createBranch(repoId: string, branchName: string, sha: string): Promise<void> {
  const token = await secrets.require("HF_PUBLISH_TOKEN");
  const res = await fetch(`${HF_API}/repos/${repoId}/branches`, {
    method: "POST",
    headers: hfHeaders(token),
    body: JSON.stringify({ branch: branchName, ref: sha }),
  });
  if (!res.ok) throw new Error(`Failed to create branch: ${res.status} ${await res.text()}`);
}

export async function createPullRequest(repoId: string, title: string, headBranch: string, baseBranch: string = "main"): Promise<HfPrResponse> {
  const token = await secrets.require("HF_PUBLISH_TOKEN");
  const res = await fetch(`${HF_API}/repos/${repoId}/pulls`, {
    method: "POST",
    headers: hfHeaders(token),
    body: JSON.stringify({ title, head: headBranch, base: baseBranch }),
  });
  if (!res.ok) throw new Error(`Failed to create PR: ${res.status} ${await res.text()}`);
  return res.json() as Promise<HfPrResponse>;
}

export async function uploadFile(repoId: string, filePath: string, content: Buffer, revision: string): Promise<void> {
  const token = await secrets.require("HF_PUBLISH_TOKEN");
  const res = await fetch(`${HF_API}/repos/${repoId}/upload/${encodeURIComponent(filePath)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: new Uint8Array(content),
  });
  if (!res.ok) throw new Error(`Failed to upload ${filePath}: ${res.status} ${await res.text()}`);
}

export async function commitFiles(
  repoId: string,
  operations: Array<{ op: string; path: string; content?: string }>,
  commitMessage: string,
  revision: string,
): Promise<{ sha: string }> {
  const token = await secrets.require("HF_PUBLISH_TOKEN");
  const res = await fetch(`${HF_API}/repos/${repoId}/commits`, {
    method: "POST",
    headers: hfHeaders(token),
    body: JSON.stringify({
      operations,
      commit: { message: commitMessage },
      branch: revision,
    }),
  });
  if (!res.ok) throw new Error(`Failed to commit: ${res.status} ${await res.text()}`);
  return res.json() as Promise<{ sha: string }>;
}

export async function getRemoteTree(
  repoId: string,
  revision: string,
): Promise<Array<{ path: string; sha: string; size: number; type: string }>> {
  const token = await secrets.require("HF_PUBLISH_TOKEN");
  const res = await fetch(`${HF_API}/repos/${repoId}/tree/${revision}?recursive=true`, {
    headers: hfHeaders(token),
  });
  if (!res.ok) throw new Error(`Failed to get tree: ${res.status}`);
  return res.json() as Promise<Array<{ path: string; sha: string; size: number; type: string }>>;
}
