/** Coordinates asynchronous browser work against a changing lecture revision. */
export type OperationTicket = { revision: number; controller: AbortController };

export function createOperationRevision() {
  let revision = 0;
  const active = new Set<AbortController>();

  return {
    revision: () => revision,
    begin(): OperationTicket {
      const controller = new AbortController();
      active.add(controller);
      return { revision, controller };
    },
    isCurrent(ticket: OperationTicket) {
      return ticket.revision === revision && active.has(ticket.controller) && !ticket.controller.signal.aborted;
    },
    finish(ticket: OperationTicket) {
      active.delete(ticket.controller);
    },
    invalidate() {
      revision++;
      for (const controller of active) controller.abort();
      active.clear();
      return revision;
    },
  };
}
