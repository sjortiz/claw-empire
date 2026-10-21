/** Only execution metadata can mark a timeout; meeting prose is ordinary content. */
export function isMeetingRunTimeout(
  run: { error?: string; status?: string; timedOut?: boolean } | null | undefined,
): boolean {
  return (
    run?.timedOut === true ||
    /^(?:timeout|timed[_ -]?out|aborted)$/i.test(run?.status ?? "") ||
    /timeout after|timed out|request timed out|aborted/i.test(run?.error ?? "")
  );
}
