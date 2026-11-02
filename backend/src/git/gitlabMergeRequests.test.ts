import { describe, expect, it, vi } from 'vitest';

// Conversion seule : le module GitLab des comptes (coffre, base) n'est pas chargé.
vi.mock('../settings/gitlab.js', () => ({ gitlabFetch: vi.fn() }));
const { approvalDecision, diffLineStats, jobState, pipelineState, toPullRequest } = await import('./gitlabMergeRequests.js');

const mr = (over: Record<string, unknown> = {}) =>
  ({
    iid: 3,
    title: 'Ma MR',
    description: null,
    state: 'opened',
    web_url: 'https://gitlab.com/g/p/-/merge_requests/3',
    author: null,
    source_branch: 'feat/x',
    target_branch: 'main',
    source_project_id: 1,
    target_project_id: 1,
    created_at: '2026-11-01T10:00:00Z',
    updated_at: '2026-11-01T10:00:00Z',
    ...over,
  }) as Parameters<typeof toPullRequest>[2];

describe('merge requests GitLab : conversion', () => {
  it('traduit les états de la MR', () => {
    expect(toPullRequest('p', 'g/p', mr()).state).toBe('OPEN');
    expect(toPullRequest('p', 'g/p', mr({ state: 'merged', merged_at: '2026-11-02T10:00:00Z' }))).toMatchObject({ state: 'MERGED', mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' });
    expect(toPullRequest('p', 'g/p', mr({ state: 'closed' })).state).toBe('CLOSED');
    expect(toPullRequest('p', 'g/p', mr({ source_project_id: 2 })).isCrossRepository).toBe(true);
  });

  it('reconnaît les brouillons, les conflits et les calculs en cours', () => {
    expect(toPullRequest('p', 'g/p', mr({ draft: true }))).toMatchObject({ isDraft: true, mergeStateStatus: 'DRAFT' });
    expect(toPullRequest('p', 'g/p', mr({ title: 'Draft: Ma MR' })).isDraft).toBe(true);
    expect(toPullRequest('p', 'g/p', mr({ has_conflicts: true }))).toMatchObject({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' });
    expect(toPullRequest('p', 'g/p', mr({ detailed_merge_status: 'checking' })).mergeable).toBe('UNKNOWN');
    expect(toPullRequest('p', 'g/p', mr({ detailed_merge_status: 'need_rebase' })).mergeStateStatus).toBe('BEHIND');
    expect(toPullRequest('p', 'g/p', mr({ detailed_merge_status: 'not_approved' })).mergeStateStatus).toBe('BLOCKED');
    expect(toPullRequest('p', 'g/p', mr({ detailed_merge_status: 'mergeable' })).mergeStateStatus).toBe('CLEAN');
  });

  it('résume le pipeline du dernier commit, même sans ses jobs', () => {
    const pr = toPullRequest('p', 'g/p', mr({ head_pipeline: { id: 9, status: 'running', web_url: 'https://x/9' } }));
    expect(pr).toMatchObject({ checksState: 'PENDING', checks: [{ name: 'pipeline #9', state: 'PENDING', url: 'https://x/9' }] });
    expect(pipelineState('success')).toBe('SUCCESS');
    expect(pipelineState('failed')).toBe('FAILURE');
    expect(pipelineState('canceled')).toBe('ERROR');
    expect(pipelineState('skipped')).toBeNull();
    expect(jobState({ status: 'failed', allow_failure: true })).toBe('NEUTRAL');
    expect(jobState({ status: 'manual' })).toBe('NEUTRAL');
    expect(jobState({ status: 'pending' })).toBe('PENDING');
  });

  it('déduit la décision de revue des approbations', () => {
    expect(approvalDecision(null)).toBeNull();
    expect(approvalDecision({ approvals_left: 1, approved_by: [] })).toBe('REVIEW_REQUIRED');
    expect(approvalDecision({ approvals_left: 0, approved_by: [{ user: { username: 'a' } }] })).toBe('APPROVED');
    expect(approvalDecision({ approvals_left: 0, approved_by: [] })).toBeNull();
    expect(approvalDecision(null, 'requested_changes')).toBe('CHANGES_REQUESTED');
  });

  it('compte les lignes d’un diff unifié', () => {
    expect(diffLineStats('--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n+plus\n context')).toEqual({ additions: 2, deletions: 1 });
  });
});
