export class RuntimeFailureGate {
  private probeActive = false;

  beginProbe(): void {
    this.probeActive = true;
  }

  endProbe(): void {
    this.probeActive = false;
  }

  get probeInProgress(): boolean {
    return this.probeActive;
  }

  report(applyFailure: () => void): void {
    if (this.probeActive) {
      return;
    }
    applyFailure();
  }
}
