declare const prisma: {
  $queryRawUnsafe(sql: string): Promise<unknown>;
};
declare const connection: {
  query(sql: string): Promise<unknown>;
};

export async function runRuntime(tableName: string): Promise<void> {
  await prisma.$queryRawUnsafe(`select * from ${tableName}`);
  const sql = "select * from " + tableName;
  await connection.query(sql);
}
