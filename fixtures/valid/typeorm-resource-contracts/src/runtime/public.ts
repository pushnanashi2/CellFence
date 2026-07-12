import { Entity } from "typeorm";

@Entity("app_users")
class User {}

declare const dataSource: {
  getRepository(entity: unknown): {
    find(): unknown;
    save(value: unknown): unknown;
  };
  createQueryBuilder(): {
    select(): {
      from(tableName: string | unknown, alias: string): unknown;
    };
    insert(): {
      into(entity: unknown): unknown;
    };
  };
};

export function runTypeOrm(): void {
  const repository = dataSource.getRepository(User);
  repository.find();
  repository.save({});
  dataSource.createQueryBuilder().select().from("audit_logs", "audit");
  dataSource.createQueryBuilder().insert().into(User);
}
