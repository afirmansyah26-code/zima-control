export function operationalLog(event: string, fields: Readonly<Record<string, string | number>> = {}): void {
  process.stdout.write(JSON.stringify({ timestamp: new Date().toISOString(), component: "runtime-authority", event, ...fields }) + "\n");
}
