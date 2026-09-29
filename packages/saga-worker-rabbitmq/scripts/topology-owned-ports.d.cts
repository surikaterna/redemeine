declare const ports: {
  ownedId(output: string, name: string, id: string, runId: string): string;
  mappedPort(output: string): number;
};
export = ports;
