import * as vscode from "vscode";

const CHANNEL_NAME = "HeadsDown";

/**
 * Timestamped output channel for HeadsDown logging.
 * All log lines are prefixed with [HH:MM:SS] timestamps.
 */
export class OutputLogger {
  private channel: vscode.OutputChannel;

  constructor(channel?: vscode.OutputChannel) {
    this.channel = channel ?? vscode.window.createOutputChannel(CHANNEL_NAME);
  }

  /** Log a message with a timestamp prefix. */
  log(message: string): void {
    const timestamp = this.formatTimestamp(new Date());
    this.channel.appendLine(`[${timestamp}] ${message}`);
  }

  /** Show the output channel in the editor. */
  show(): void {
    this.channel.show(true);
  }

  /** Dispose the output channel. */
  dispose(): void {
    this.channel.dispose();
  }

  /** Format a Date to HH:MM:SS. */
  private formatTimestamp(date: Date): string {
    const h = date.getHours().toString().padStart(2, "0");
    const m = date.getMinutes().toString().padStart(2, "0");
    const s = date.getSeconds().toString().padStart(2, "0");
    return `${h}:${m}:${s}`;
  }
}
