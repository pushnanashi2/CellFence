declare const dataSource: {
  createQueryBuilder(): {
    select(): {
      from(tableName: string, alias: string): unknown;
    };
  };
};

declare const tableName: string;

export function runQuery(): unknown {
  return dataSource.createQueryBuilder().select().from(tableName, "t");
}
