/**
 * Not used.
 *
 * An earlier draft routed "open the breakdown at this section" through a ref-backed
 * hook so that a deeply nested child could trigger it without prop drilling. In the
 * end SegmentPeek receives the callback as a prop, so the indirection bought nothing
 * and was removed rather than left as dead weight.
 */
export {};