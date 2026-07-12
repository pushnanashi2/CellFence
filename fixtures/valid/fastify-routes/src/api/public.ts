declare const server: {
  route(config: { method: string[]; url: string; handler: () => void }): void;
};

export function registerRoutes(): void {
  server.route({
    method: ["GET", "POST"],
    url: "/health",
    handler: () => undefined,
  });
}
