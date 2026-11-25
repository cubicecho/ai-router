/** A request the workdir server turns down, with a message that says what to send instead. */
export class WorkdirRefusal extends Error {
  /**
   * Builds the refusal.
   *
   * @param message - What was wrong, written for the agent that asked.
   */
  constructor(message: string) {
    super(message);
    this.name = 'WorkdirRefusal';
  }
}
