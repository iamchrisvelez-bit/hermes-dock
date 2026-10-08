/**
 * Sandbox detection. A separate directory or terminal session is NOT isolation, so this
 * milestone never enables executable agent work: no isolation boundary has been verified
 * end-to-end yet. The report says so plainly instead of silently falling back to the host.
 */
export interface SandboxReport {
  executableWorkEnabled: boolean;
  reason: string;
  candidates: Array<{ name: string; present: boolean; note: string }>;
}

export function sandboxReport(probe: { dockerCli: boolean }): SandboxReport {
  return {
    executableWorkEnabled: false,
    reason:
      'No isolation boundary has been verified for agent-executed code in this milestone. ' +
      'Executable work stays disabled; tasks are limited to text deliverables written by the control plane.',
    candidates: [
      {
        name: 'docker',
        present: probe.dockerCli,
        note: probe.dockerCli
          ? 'Docker CLI found. A hardened container runner (no host mounts beyond the project workspace, no network) is the planned next step.'
          : 'Docker CLI not found.',
      },
      {
        name: 'hermes terminal backend',
        present: false,
        note: 'Hermes supports docker/singularity/modal terminal backends; enabling one is an owner-approved host change.',
      },
    ],
  };
}
