/**
 * Report-step hook. The engine and oracles wrap every user-visible operation
 * in `step(title, body)` so a test runner can render the journey as a tree
 * (Playwright: test.step). Outside a runner the default just runs the body.
 * Titles are business language only: sureify_ids, option labels, breadcrumb
 * titles, statuses — never UUIDs, never answer values.
 */
export type StepFn = <T>(title: string, body: () => Promise<T> | T) => Promise<T>;

export const noStep: StepFn = async (_title, body) => body();

/** Compact "a, b, c (+N more)" for step titles. */
export function listIds(ids: string[], max = 6): string {
  return ids.length <= max ? ids.join(', ') : `${ids.slice(0, max).join(', ')} (+${ids.length - max} more)`;
}
