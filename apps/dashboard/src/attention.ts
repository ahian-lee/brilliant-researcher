import type { WorkbenchApproval, WorkbenchSessionDetail } from './workbenchTypes';

/** Shared by the overview, conversation badge, and actionable request list. */
export function needsHumanDecision(detail: WorkbenchSessionDetail, approval: WorkbenchApproval): boolean {
  if (approval.kind === 'question') return true;
  const review = detail.approvalReviews?.find(item => item.approvalId === approval.id);
  if (review) return ['human_required', 'unknown'].includes(review.state);
  return !detail.approvalReviewStatus?.enabled || detail.session?.provider !== 'dsh-pi';
}

export function summarizeAttention(pending: WorkbenchSessionDetail[], questionCount = 0) {
  // A waiting session with no readable original request is unknown, not an
  // automatic review and not evidence that no human response is needed.
  const humanDetails = pending.map(detail => ({ ...detail, approvals: (detail.approvals ?? []).filter(item => needsHumanDecision(detail, item)) }))
    .filter((detail, index) => !!detail.error || !!detail.approvals.length || !pending[index].approvals?.length);
  const automaticDetails = pending.map(detail => ({ ...detail, approvals: (detail.approvals ?? []).filter(item => !needsHumanDecision(detail, item)) }))
    .filter(detail => !!detail.approvals.length);
  return {
    humanDetails,
    automaticDetails,
    humanCount: questionCount + humanDetails.reduce((count, detail) => count + Math.max(1, detail.approvals.length), 0),
    automaticCount: automaticDetails.reduce((count, detail) => count + detail.approvals.length, 0),
  };
}
