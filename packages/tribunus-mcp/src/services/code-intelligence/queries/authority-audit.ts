import { getCodeIntelligenceKernel } from "../indexer.js"
import type { AuthorityAuditQueryV1, AuthorityAuditResultV1 } from "../store/code-index-types.js"

export async function authorityAudit(repoRoot: string, input: AuthorityAuditQueryV1): Promise<AuthorityAuditResultV1> {
  return getCodeIntelligenceKernel(repoRoot).auditAuthority(input)
}
