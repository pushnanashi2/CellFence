declare const prisma: {
  user: {
    findMany(): Promise<unknown[]>;
    create(args: unknown): Promise<unknown>;
  };
};

export async function runRuntime(): Promise<void> {
  await prisma.user.findMany();
  await prisma.user.create({ data: { id: "u1" } });
}
