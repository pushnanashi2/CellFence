declare class Queue {
  constructor(name: string);
  add(name: string, payload: unknown): Promise<void>;
}
declare class Worker {
  constructor(name: string, handler: (payload: unknown) => Promise<void>);
}
declare const producer: {
  send(args: { topic: string; messages: unknown[] }): Promise<void>;
};
declare const consumer: {
  subscribe(args: { topic: string }): Promise<void>;
};

export async function runRuntime(): Promise<void> {
  const queue = new Queue("nightly-research");
  await queue.add("run", {});
  new Worker("nightly-research", async () => undefined);
  await producer.send({ topic: "research.events", messages: [] });
  await consumer.subscribe({ topic: "research.events" });
}
