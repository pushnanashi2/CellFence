import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { checkRepository } from "../packages/engine/dist/index.js";
import { addResourceAccess, collectResourceAccesses } from "../packages/engine/dist/resource-access.js";

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function createResourceContext(rootDir, governance = {}) {
  return {
    rootDir,
    manifest: {
      schemaVersion: "cellfence.manifest.v1",
      governance,
      cells: [{
        id: "runtime",
        ownedPaths: ["src/runtime/**"],
        publicEntry: "src/runtime/public.ts",
        publicSymbols: ["runRuntime"],
        consumes: [],
        producesArtifacts: [],
      }],
    },
    sourceFilesForCellCache: new Map(),
    sourceTextCache: new Map(),
    sourceFileCache: new Map(),
  };
}

function accessKey(access) {
  return [
    access.kind,
    access.access,
    access.selector,
    access.source || "",
    access.detectedBy,
    access.confidence,
    access.unresolved ? "unresolved" : "resolved",
    access.reason || "",
  ].join("|");
}

function summarizeAccesses(accesses) {
  return accesses
    .map((access) => ({
      kind: access.kind,
      access: access.access,
      selector: access.selector,
      source: access.source,
      detectedBy: access.detectedBy,
      confidence: access.confidence,
      unresolved: access.unresolved || false,
      reason: access.reason || "",
      line: access.line,
    }))
    .sort((left, right) => accessKey(left).localeCompare(accessKey(right)) || left.line - right.line);
}

function writeRuntimeSource(rootDir, lines) {
  fs.mkdirSync(path.join(rootDir, "src/runtime"), { recursive: true });
  const filePath = path.join(rootDir, "src/runtime/public.ts");
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`);
  return filePath;
}

function lineOf(lines, needle) {
  const index = lines.findIndex((line) => line.includes(needle));
  assert.notEqual(index, -1, `missing source line containing ${needle}`);
  return index + 1;
}

function countMatching(accesses, predicate) {
  return accesses.filter(predicate).length;
}

test("addResourceAccess only suppresses exact duplicate resource observations", () => {
  const accesses = [];
  const baseAccess = {
    kind: "database",
    access: "read",
    selector: "app_users",
    filePath: "src/runtime/public.ts",
    line: 10,
    source: "findMany",
    detectedBy: "prisma-adapter",
    confidence: "high",
  };

  addResourceAccess(accesses, baseAccess);
  addResourceAccess(accesses, { ...baseAccess });
  addResourceAccess(accesses, { ...baseAccess, access: "write" });
  addResourceAccess(accesses, { ...baseAccess, selector: "audit_logs" });
  addResourceAccess(accesses, { ...baseAccess, filePath: "src/runtime/other.ts" });
  addResourceAccess(accesses, { ...baseAccess, line: 11 });

  assert.equal(accesses.length, 5);
  assert.deepEqual(accesses.map((access) => `${access.access}:${access.selector}:${access.filePath}:${access.line}`), [
    "read:app_users:src/runtime/public.ts:10",
    "write:app_users:src/runtime/public.ts:10",
    "read:audit_logs:src/runtime/public.ts:10",
    "read:app_users:src/runtime/other.ts:10",
    "read:app_users:src/runtime/public.ts:11",
  ]);
});

test("collectResourceAccesses covers the full Prisma delegate method vocabulary", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-resource-prisma-vocabulary-"));
  try {
    fs.mkdirSync(path.join(rootDir, "prisma"), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, "prisma/schema.prisma"),
      [
        "model User {",
        "  id Int @id",
        "  @@map(\"app_users\")",
        "}",
        "",
      ].join("\n"),
    );
    const lines = [
      "declare const PrismaClient: new () => { user: {",
      "  findMany(): unknown; findFirst(): unknown; findUnique(): unknown; count(): unknown; aggregate(): unknown; groupBy(): unknown;",
      "  create(input: unknown): unknown; createMany(input: unknown): unknown; update(input: unknown): unknown; updateMany(input: unknown): unknown;",
      "  upsert(input: unknown): unknown; delete(input: unknown): unknown; deleteMany(input: unknown): unknown; unknownMethod(): unknown;",
      "} };",
      "const client = new PrismaClient();",
      "export function runRuntime(): void {",
      "  client.user.findMany();",
      "  client.user.findFirst();",
      "  client.user.findUnique();",
      "  client.user.count();",
      "  client.user.aggregate();",
      "  client.user.groupBy();",
      "  client.user.create({});",
      "  client.user.createMany({});",
      "  client.user.update({});",
      "  client.user.updateMany({});",
      "  client.user.upsert({});",
      "  client.user.delete({});",
      "  client.user.deleteMany({});",
      "  client.user.unknownMethod();",
      "}",
    ];
    const filePath = writeRuntimeSource(rootDir, lines);
    const accesses = collectResourceAccesses(createResourceContext(rootDir), filePath);
    const prismaAccesses = accesses.filter((access) => access.detectedBy === "prisma-adapter" && access.selector === "app_users");

    assert.equal(countMatching(prismaAccesses, (access) => access.access === "read"), 6);
    assert.equal(countMatching(prismaAccesses, (access) => access.access === "write"), 7);
    assert.equal(countMatching(accesses, (access) => access.source === "unknownMethod"), 0);
    assert.equal(prismaAccesses.find((access) => access.source === "findMany")?.line, lineOf(lines, "client.user.findMany"));
    assert.ok(prismaAccesses.every((access) => access.confidence === "high"));
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("collectResourceAccesses covers TypeORM repository read and write vocabularies", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-resource-typeorm-vocabulary-"));
  try {
    const lines = [
      "declare function Entity(options?: unknown): ClassDecorator;",
      "@Entity({ name: 'app_users' })",
      "class User {}",
      "declare function getRepository(entity: unknown): {",
      "  find(): unknown; findBy(input: unknown): unknown; findOne(input: unknown): unknown; findOneBy(input: unknown): unknown;",
      "  count(): unknown; countBy(input: unknown): unknown; exist(input: unknown): unknown;",
      "  save(input: unknown): unknown; insert(input: unknown): unknown; update(input: unknown): unknown; upsert(input: unknown): unknown;",
      "  delete(input: unknown): unknown; remove(input: unknown): unknown; softDelete(input: unknown): unknown; restore(input: unknown): unknown;",
      "};",
      "const repo = getRepository(User);",
      "export function runRuntime(): void {",
      "  repo.find();",
      "  repo.findBy({});",
      "  repo.findOne({});",
      "  repo.findOneBy({});",
      "  repo.count();",
      "  repo.countBy({});",
      "  repo.exist({});",
      "  repo.save({});",
      "  repo.insert({});",
      "  repo.update({});",
      "  repo.upsert({});",
      "  repo.delete({});",
      "  repo.remove({});",
      "  repo.softDelete({});",
      "  repo.restore({});",
      "}",
    ];
    const filePath = writeRuntimeSource(rootDir, lines);
    const accesses = collectResourceAccesses(createResourceContext(rootDir), filePath)
      .filter((access) => access.detectedBy === "typeorm-adapter" && access.selector === "app_users");

    assert.equal(countMatching(accesses, (access) => access.access === "read"), 7);
    assert.equal(countMatching(accesses, (access) => access.access === "write"), 8);
    assert.equal(accesses.find((access) => access.source === "save")?.line, lineOf(lines, "repo.save"));
    assert.ok(accesses.every((access) => access.confidence === "high"));
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("collectResourceAccesses covers file, HTTP, and generic queue call vocabularies", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-resource-call-vocabulary-"));
  try {
    const lines = [
      "declare const pathName: string;",
      "declare function readFile(path: string): unknown;",
      "declare function readFileSync(path: string): unknown;",
      "declare function createReadStream(path: string): unknown;",
      "declare function readdir(path: string): unknown;",
      "declare function readdirSync(path: string): unknown;",
      "declare function writeFile(path: string, data: string): unknown;",
      "declare function writeFileSync(path: string, data: string): unknown;",
      "declare function appendFile(path: string, data: string): unknown;",
      "declare function appendFileSync(path: string, data: string): unknown;",
      "declare function createWriteStream(path: string): unknown;",
      "declare function fetch(url: string): unknown;",
      "declare function request(url: string): unknown;",
      "declare const router: { get(path: string): unknown; post(path: string): unknown; put(path: string): unknown; patch(path: string): unknown; delete(path: string): unknown };",
      "declare const bus: { publish(topic: string): unknown; enqueue(topic: string): unknown; emitEvent(topic: string): unknown; sendMessage(topic: string): unknown;",
      "  subscribe(topic: string): unknown; consume(topic: string): unknown; dequeue(topic: string): unknown; receiveMessage(topic: string): unknown;",
      "  publishLater(topic: string): unknown; subscribeLater(topic: string): unknown };",
      "export function runRuntime(): void {",
      "  readFile('data/read.txt');",
      "  readFileSync('data/read-sync.txt');",
      "  createReadStream('data/read-stream.txt');",
      "  readdir('data/dir');",
      "  readdirSync('data/dir-sync');",
      "  writeFile('data/write.txt', '');",
      "  writeFileSync('data/write-sync.txt', '');",
      "  appendFile('data/append.txt', '');",
      "  appendFileSync('data/append-sync.txt', '');",
      "  createWriteStream('data/write-stream.txt');",
      "  readFile(pathName);",
      "  fetch('https://api.example.test/fetch');",
      "  request('http://api.example.test/request');",
      "  router.get('/get');",
      "  router.post('/post');",
      "  router.put('/put');",
      "  router.patch('/patch');",
      "  router.delete('/delete');",
      "  bus.publish('events.publish');",
      "  bus.enqueue('events.enqueue');",
      "  bus.emitEvent('events.emit');",
      "  bus.sendMessage('events.message');",
      "  bus.subscribe('events.subscribe');",
      "  bus.consume('events.consume');",
      "  bus.dequeue('events.dequeue');",
      "  bus.receiveMessage('events.receive');",
      "  bus.publishLater('events.later');",
      "  bus.subscribeLater('events.later');",
      "}",
    ];
    const filePath = writeRuntimeSource(rootDir, lines);
    const accesses = summarizeAccesses(collectResourceAccesses(createResourceContext(rootDir), filePath));

    assert.equal(countMatching(accesses, (access) => access.kind === "file" && access.access === "read" && !access.unresolved), 5);
    assert.equal(countMatching(accesses, (access) => access.kind === "file" && access.access === "write" && !access.unresolved), 5);
    assert.equal(countMatching(accesses, (access) => access.kind === "file" && access.selector === "unresolved:dynamic-file-path" && access.unresolved), 1);
    assert.equal(countMatching(accesses, (access) => access.kind === "http" && access.access === "call"), 2);
    assert.equal(countMatching(accesses, (access) => access.kind === "http" && access.access === "serve"), 5);
    assert.equal(countMatching(accesses, (access) => access.kind === "queue" && access.access === "publish"), 4);
    assert.equal(countMatching(accesses, (access) => access.kind === "queue" && access.access === "subscribe"), 4);
    assert.equal(accesses.find((access) => access.selector === "data/read.txt")?.detectedBy, "readFile");
    assert.equal(accesses.find((access) => access.selector === "GET /get")?.line, lineOf(lines, "router.get"));
    assert.equal(accesses.find((access) => access.selector === "unresolved:dynamic-file-path")?.reason, "file path argument is not a static literal");
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("collectResourceAccesses keeps adapter disabled switches fail-closed for every built-in detector", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-resource-disabled-direct-"));
  try {
    const lines = [
      "declare const PrismaClient: new () => { user: { findMany(): unknown } };",
      "const prismaClient = new PrismaClient();",
      "declare function Entity(options?: unknown): ClassDecorator;",
      "@Entity('app_users')",
      "class User {}",
      "declare function getRepository(entity: unknown): { find(): unknown };",
      "declare function pgTable(name: string): unknown;",
      "const users = pgTable('users');",
      "declare const db: { select: { from(table: unknown): unknown } };",
      "declare function createQueryBuilder(): { from(table: string): unknown };",
      "declare function Controller(path?: string): ClassDecorator;",
      "declare function Get(path?: string): MethodDecorator;",
      "@Controller('/api')",
      "class ApiController { @Get('/health') health(): void {} }",
      "declare const server: { route(config: unknown): void };",
      "declare const Queue: new (queueName: string) => { add(name: string, payload: unknown): void };",
      "declare const Worker: new (queueName: string, processor: unknown) => unknown;",
      "const jobs = new Queue('jobs');",
      "declare const kafkaProducer: { send(config: unknown): void };",
      "declare const sqlClient: { query(sql: string): void };",
      "declare function readFile(path: string): unknown;",
      "declare function fetch(url: string): unknown;",
      "declare const bus: { publish(topic: string): unknown };",
      "export function runRuntime(): void {",
      "  prismaClient.user.findMany();",
      "  getRepository(User).find();",
      "  db.select.from(users);",
      "  createQueryBuilder().from('audit_logs');",
      "  server.route({ path: '/status', method: 'GET' });",
      "  jobs.add('run', {});",
      "  new Worker('jobs', () => undefined);",
      "  kafkaProducer.send({ topic: 'orders.created' });",
      "  sqlClient.query('select * from app_users');",
      "  readFile('data/input.json');",
      "  fetch('https://api.example.test');",
      "  bus.publish('domain.events');",
      "}",
    ];
    const filePath = writeRuntimeSource(rootDir, lines);
    const context = createResourceContext(rootDir, {
      resourceAdapters: {
        file: "off",
        http: "off",
        queue: "off",
        "sql-literal": "off",
        prisma: "off",
        typeorm: "off",
        drizzle: "off",
        "query-builder": "off",
        bullmq: "off",
        kafkajs: "off",
        nestjs: "off",
        fastify: "off",
      },
    });

    assert.deepEqual(collectResourceAccesses(context, filePath), []);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("collectResourceAccesses covers NestJS decorators and normalized route paths exactly", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-resource-nest-vocabulary-"));
  try {
    const lines = [
      "declare function Controller(path?: string): ClassDecorator;",
      "declare function Get(path?: string): MethodDecorator;",
      "declare function Post(path?: string): MethodDecorator;",
      "declare function Put(path?: string): MethodDecorator;",
      "declare function Patch(path?: string): MethodDecorator;",
      "declare function Delete(path?: string): MethodDecorator;",
      "declare function Options(path?: string): MethodDecorator;",
      "declare function Head(path?: string): MethodDecorator;",
      "declare function All(path?: string): MethodDecorator;",
      "declare function Other(path?: string): MethodDecorator;",
      "@Controller(' /api//v1/ ')",
      "class ApiController {",
      "  @Get(' /users// ')",
      "  list(): void {}",
      "  @Post('/users')",
      "  create(): void {}",
      "  @Put('/users/:id')",
      "  replace(): void {}",
      "  @Patch('/users/:id')",
      "  update(): void {}",
      "  @Delete('/users/:id')",
      "  remove(): void {}",
      "  @Options('/users')",
      "  options(): void {}",
      "  @Head('/users')",
      "  head(): void {}",
      "  @All('/everything')",
      "  all(): void {}",
      "  @Other('/ignored')",
      "  ignored(): void {}",
      "}",
      "@Other('/not-controller')",
      "class OtherController { @Get('/ignored-other') ignored(): void {} }",
      "class PlainController { @Get('/ignored') ignored(): void {} }",
      "export const done = true;",
    ];
    const filePath = writeRuntimeSource(rootDir, lines);
    const accesses = summarizeAccesses(collectResourceAccesses(createResourceContext(rootDir), filePath))
      .filter((access) => access.detectedBy === "nestjs-adapter");

    assert.deepEqual(accesses.map((access) => `${access.selector}:${access.source}:${access.line}`), [
      `ALL /api/v1/everything:All:${lineOf(lines, "@All")}`,
      `DELETE /api/v1/users/:id:Delete:${lineOf(lines, "@Delete")}`,
      `GET /api/v1/users:Get:${lineOf(lines, "@Get(' /users// ')")}`,
      `HEAD /api/v1/users:Head:${lineOf(lines, "@Head")}`,
      `OPTIONS /api/v1/users:Options:${lineOf(lines, "@Options")}`,
      `PATCH /api/v1/users/:id:Patch:${lineOf(lines, "@Patch")}`,
      `POST /api/v1/users:Post:${lineOf(lines, "@Post")}`,
      `PUT /api/v1/users/:id:Put:${lineOf(lines, "@Put")}`,
    ]);
    assert.ok(accesses.every((access) => access.confidence === "high"));
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("collectResourceAccesses rejects near-miss object properties and non-resource calls", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-resource-near-misses-"));
  try {
    const lines = [
      "declare const server: { route(config: unknown): void };",
      "declare const kafkaProducer: { send(config: unknown): void };",
      "declare const kafkaConsumer: { subscribe(config: unknown): void };",
      "declare const tableName: string;",
      "declare const sqlClient: { query(input: unknown): void };",
      "declare function fetch(url: string): unknown;",
      "declare const router: { get(path: string): unknown };",
      "declare const bus: { publish(topic: string): unknown; sendMessage(topic: string): unknown };",
      "declare function readFile(path: string): unknown;",
      "export function runRuntime(): void {",
      "  const callback = () => () => undefined;",
      "  callback()();",
      "  server.route({ 'wrong': '/wrong', 'path': ' /status// ', 'method': ['get', 'post', 1] });",
      "  server.route({ path: '/no-method' });",
      "  server.route({ method: 'GET' });",
      "  server.route({ path: '/numeric-methods', method: [1] });",
      "  server.route({ wrong: '/missing-method' });",
      "  kafkaProducer.send({ 'wrongTopic': 'ignored', 'topic': 'orders.created' });",
      "  kafkaConsumer.subscribe({ 'wrongTopic': 'ignored', 'topic': 'orders.created' });",
      "  sqlClient.query('select * from app_users join audit_logs on true');",
      "  sqlClient.query('insert into audit_logs values (1)');",
      "  sqlClient.query('update app_users set id = id');",
      "  sqlClient.query('this is not sql');",
      "  const dynamicSql = 'select * from ' + tableName;",
      "  const notSql = 'hello ' + tableName;",
      "  sqlClient.query(dynamicSql);",
      "  sqlClient.query(notSql);",
      "  sqlClient.query(tableName);",
      "  fetch('/relative-not-http');",
      "  router.get('relative-route');",
      "  bus.publish('/not-a-queue-route');",
      "  bus.publish('http://not-a-queue.example/topic');",
      "  bus.sendMessage('https://not-a-queue.example.test/topic');",
      "  readFile();",
      "}",
    ];
    const filePath = writeRuntimeSource(rootDir, lines);
    const accesses = summarizeAccesses(collectResourceAccesses(createResourceContext(rootDir), filePath));

    assert.deepEqual(accesses.map((access) => `${access.kind}:${access.access}:${access.selector}:${access.detectedBy}:${access.reason}`), [
      "database:read:app_users:sql-literal:",
      "database:read:audit_logs:sql-literal:",
      "database:read:unresolved:dynamic-sql:sql-literal:SQL query is assembled dynamically",
      "database:write:app_users:sql-literal:",
      "database:write:audit_logs:sql-literal:",
      "http:serve:GET /status:fastify-adapter:",
      "http:serve:POST /status:fastify-adapter:",
      "queue:publish:kafka:orders.created:kafkajs-adapter:",
      "queue:subscribe:kafka:orders.created:kafkajs-adapter:",
    ]);
    assert.equal(accesses.find((access) => access.selector === "GET /status")?.line, lineOf(lines, "server.route({ 'wrong': '/wrong'"));
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("collectResourceAccesses keeps query-builder, BullMQ, and Kafka edge guards precise", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-resource-edge-guards-"));
  try {
    const lines = [
      "declare function createQueryBuilder(): { select(): { from(table: string): unknown }, delete(): { from(table: string): unknown }, update(table: string): unknown, from(table: string): unknown };",
      "declare const queryDb: { selectFrom(table: string): unknown; insertInto(table: string): unknown; updateTable(table: string): unknown; deleteFrom(table: string): unknown };",
      "declare const db: { select: { from(table: unknown): unknown }, update(table: unknown): unknown };",
      "declare const notDb: { update(table: unknown): unknown };",
      "declare function pgTable(name: string): unknown;",
      "const users = pgTable('users');",
      "declare const Queue: new (queueName: string) => { add(name: string, payload: unknown): void; notAdd(name: string): void };",
      "declare const Worker: new (queueName?: string, processor?: unknown) => unknown;",
      "declare const NotWorker: new (queueName: string) => unknown;",
      "const jobs = new Queue('jobs');",
      "const unknownQueue = { add(name: string): void {} };",
      "declare const kafkaProducer: { send(config: unknown): void };",
      "declare const kafkaConsumer: { subscribe(config: unknown): void };",
      "export function runRuntime(): void {",
      "  createQueryBuilder().select().from('read_table');",
      "  createQueryBuilder().delete().from('delete_table');",
      "  createQueryBuilder().update('update_table');",
      "  createQueryBuilder().from('plain_from_table');",
      "  queryDb.selectFrom('generic_read');",
      "  queryDb.insertInto('generic_insert');",
      "  queryDb.updateTable('generic_update');",
      "  queryDb.deleteFrom('generic_delete');",
      "  db.select.from(users);",
      "  db.update(users);",
      "  notDb.update(users);",
      "  jobs.add('run', {});",
      "  jobs.notAdd('not-bullmq-add');",
      "  unknownQueue.add('ignored');",
      "  new Worker('jobs', () => undefined);",
      "  new Worker();",
      "  new NotWorker('jobs');",
      "  kafkaProducer.send({ topic: 'orders.created' });",
      "  kafkaProducer.send({ topicName: 'ignored' });",
      "  kafkaConsumer.subscribe({ topic: 'orders.created' });",
      "  kafkaConsumer.subscribe({ topicName: 'ignored' });",
      "}",
    ];
    const filePath = writeRuntimeSource(rootDir, lines);
    const accesses = summarizeAccesses(collectResourceAccesses(createResourceContext(rootDir), filePath));

    assert.deepEqual(accesses.map((access) => `${access.kind}:${access.access}:${access.selector}:${access.detectedBy}:${access.source}:${access.confidence}`), [
      "database:read:generic_read:query-builder-adapter:selectFrom:medium",
      "database:read:plain_from_table:typeorm-adapter:from:medium",
      "database:read:read_table:typeorm-adapter:from:medium",
      "database:read:users:drizzle-adapter:from:high",
      "database:write:delete_table:typeorm-adapter:from:medium",
      "database:write:generic_delete:query-builder-adapter:deleteFrom:medium",
      "database:write:generic_insert:query-builder-adapter:insertInto:medium",
      "database:write:generic_update:query-builder-adapter:updateTable:medium",
      "database:write:update_table:typeorm-adapter:update:medium",
      "database:write:users:drizzle-adapter:update:high",
      "queue:publish:bullmq:jobs:bullmq-adapter:add:high",
      "queue:publish:kafka:orders.created:kafkajs-adapter:send:medium",
      "queue:subscribe:bullmq:jobs:bullmq-adapter:Worker:high",
      "queue:subscribe:kafka:orders.created:kafkajs-adapter:subscribe:medium",
    ]);
    assert.equal(accesses.find((access) => access.selector === "bullmq:jobs" && access.access === "subscribe")?.line, lineOf(lines, "new Worker('jobs'"));
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("collectResourceAccesses reports raw SQL unresolved reasons and unsafe calls exactly", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-resource-raw-details-"));
  try {
    const lines = [
      "declare const prisma: {",
      "  $queryRaw(input: unknown): unknown; $executeRaw(input: unknown): unknown;",
      "  $queryRawUnsafe(input: unknown): unknown; $executeRawUnsafe(input: unknown): unknown;",
      "};",
      "declare const other: { $queryRawUnsafe(input: unknown): unknown };",
      "export function runRuntime(tableName: string): void {",
      "  prisma.$queryRaw('select * from app_users');",
      "  prisma.$executeRaw('update app_users set id = id');",
      "  prisma.$queryRaw(tableName);",
      "  prisma.$queryRawUnsafe('select * from app_users');",
      "  prisma.$executeRawUnsafe('update app_users set id = id');",
      "  prisma.$queryRaw`select * from ${tableName}`;",
      "  prisma.$queryRawUnsafe`select * from app_users`;",
      "  other.$queryRawUnsafe('select * from ignored_table');",
      "}",
    ];
    const filePath = writeRuntimeSource(rootDir, lines);
    const accesses = summarizeAccesses(collectResourceAccesses(createResourceContext(rootDir), filePath));

    assert.deepEqual(accesses.map((access) => `${access.kind}:${access.access}:${access.selector}:${access.source}:${access.detectedBy}:${access.confidence}:${access.unresolved}:${access.reason}:${access.line}`), [
      `database:read:app_users:$queryRaw:prisma-adapter:medium:false::${lineOf(lines, "prisma.$queryRaw('select")}`,
      `database:read:unresolved:dynamic-sql:$executeRawUnsafe:prisma-adapter:low:true:unsafe raw SQL call:${lineOf(lines, "prisma.$executeRawUnsafe")}`,
      `database:read:unresolved:dynamic-sql:$queryRaw:prisma-adapter:low:true:raw SQL argument is not a static literal:${lineOf(lines, "prisma.$queryRaw(tableName)")}`,
      `database:read:unresolved:dynamic-sql:$queryRaw:prisma-adapter:low:true:raw SQL template contains dynamic interpolation:${lineOf(lines, "prisma.$queryRaw`")}`,
      `database:read:unresolved:dynamic-sql:$queryRawUnsafe:prisma-adapter:low:true:unsafe raw SQL call:${lineOf(lines, "prisma.$queryRawUnsafe('")}`,
      `database:read:unresolved:dynamic-sql:$queryRawUnsafe:prisma-adapter:low:true:unsafe raw SQL call:${lineOf(lines, "prisma.$queryRawUnsafe`")}`,
      `database:write:app_users:$executeRaw:prisma-adapter:medium:false::${lineOf(lines, "prisma.$executeRaw('")}`,
    ]);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("collectResourceAccesses reports unresolved dynamic table reasons exactly", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-resource-dynamic-table-details-"));
  try {
    const lines = [
      "declare const tableName: string;",
      "declare const queryDb: { selectFrom(table: unknown): unknown; insertInto(table: unknown): unknown };",
      "declare function createQueryBuilder(): { from(table: unknown): unknown; insert(): { into(table: unknown): unknown } };",
      "declare const db: { select: { from(table: unknown): unknown }, insert(table: unknown): unknown };",
      "export function runRuntime(): void {",
      "  queryDb.selectFrom(tableName);",
      "  queryDb.insertInto(tableName);",
      "  createQueryBuilder().from(tableName);",
      "  createQueryBuilder().insert().into(tableName);",
      "  db.select.from(tableName);",
      "  db.insert(tableName);",
      "}",
    ];
    const filePath = writeRuntimeSource(rootDir, lines);
    const accesses = summarizeAccesses(collectResourceAccesses(createResourceContext(rootDir), filePath));

    assert.deepEqual(accesses.map((access) => `${access.kind}:${access.access}:${access.selector}:${access.detectedBy}:${access.source}:${access.confidence}:${access.unresolved}:${access.reason}`), [
      "database:read:unresolved:dynamic-drizzle-table:drizzle-adapter:from:low:true:from table argument is not a known Drizzle table declaration",
      "database:read:unresolved:dynamic-query-builder-table:typeorm-adapter:from:low:true:from table argument is not a static literal or known entity",
      "database:read:unresolved:dynamic-query-builder-table:query-builder-adapter:selectFrom:low:true:selectFrom table argument is not a static literal or known entity",
      "database:write:unresolved:dynamic-drizzle-table:drizzle-adapter:insert:low:true:insert table argument is not a known Drizzle table declaration",
      "database:write:unresolved:dynamic-query-builder-table:query-builder-adapter:insertInto:low:true:insertInto table argument is not a static literal or known entity",
      "database:write:unresolved:dynamic-query-builder-table:typeorm-adapter:into:low:true:into table argument is not a static literal or known entity",
    ]);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("resource access detects Prisma raw SQL calls and static file writes", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-resource-raw-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src/runtime"), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, "src/runtime/public.ts"),
      [
        "declare const prisma: {",
        "  $queryRaw(sql: string): Promise<unknown>;",
        "  $executeRaw(sql: string): Promise<unknown>;",
        "};",
        "declare const fs: {",
        "  writeFileSync(filePath: string, data: string): void;",
        "  appendFileSync(filePath: string, data: string): void;",
        "};",
        "export async function runRuntime(sql: string): Promise<void> {",
        "  await prisma.$queryRaw('select * from app_users');",
        "  await prisma.$executeRaw('update app_users set id = id');",
        "  await prisma.$queryRaw(sql);",
        "  fs.writeFileSync('data/output.json', '{}');",
        "  fs.appendFileSync('data/append.json', '{}');",
        "}",
        "",
      ].join("\n"),
    );
    writeJson(path.join(rootDir, "cellfence.manifest.json"), {
      schemaVersion: "cellfence.manifest.v1",
      cells: [{
        id: "runtime",
        ownedPaths: ["src/runtime/**"],
        publicEntry: "src/runtime/public.ts",
        publicSymbols: ["runRuntime"],
        consumes: [],
        producesArtifacts: [],
        resourceContracts: [{
          id: "runtime-resources",
          kind: "database",
          access: ["read", "write"],
          selectors: ["app_users", "unresolved:dynamic-sql"],
        }, {
          id: "runtime-files",
          kind: "file",
          access: ["write"],
          selectors: ["data/output.json", "data/append.json"],
        }],
      }],
    });

    const result = checkRepository({ rootDir, manifestPath: "cellfence.manifest.json" });
    assert.equal(result.ok, true, JSON.stringify(result.findings));
    assert.deepEqual(result.metrics.runtime.resourceAccesses, [
      {
        kind: "database",
        access: "read",
        selector: "app_users",
        detectedBy: "prisma-adapter",
        confidence: "medium",
      },
      {
        kind: "database",
        access: "read",
        selector: "unresolved:dynamic-sql",
        detectedBy: "prisma-adapter",
        confidence: "low",
      },
      {
        kind: "database",
        access: "write",
        selector: "app_users",
        detectedBy: "prisma-adapter",
        confidence: "medium",
      },
      {
        kind: "file",
        access: "write",
        selector: "data/append.json",
        detectedBy: "appendFileSync",
        confidence: "high",
      },
      {
        kind: "file",
        access: "write",
        selector: "data/output.json",
        detectedBy: "writeFileSync",
        confidence: "high",
      },
    ]);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("resource access detects Prisma tagged raw SQL templates", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-resource-tagged-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src/runtime"), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, "src/runtime/public.ts"),
      [
        "declare const prisma: {",
        "  $queryRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;",
        "  $queryRawUnsafe(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;",
        "};",
        "export async function runRuntime(tableName: string): Promise<void> {",
        "  await prisma.$queryRaw`select * from app_users`;",
        "  await prisma.$queryRaw`select * from ${tableName}`;",
        "  await prisma.$queryRawUnsafe`select * from app_users`;",
        "}",
        "",
      ].join("\n"),
    );
    writeJson(path.join(rootDir, "cellfence.manifest.json"), {
      schemaVersion: "cellfence.manifest.v1",
      cells: [{
        id: "runtime",
        ownedPaths: ["src/runtime/**"],
        publicEntry: "src/runtime/public.ts",
        publicSymbols: ["runRuntime"],
        consumes: [],
        producesArtifacts: [],
        resourceContracts: [{
          id: "runtime-sql",
          kind: "database",
          access: ["read"],
          selectors: ["app_users", "unresolved:dynamic-sql"],
        }],
      }],
    });

    const result = checkRepository({ rootDir, manifestPath: "cellfence.manifest.json" });
    assert.equal(result.ok, true, JSON.stringify(result.findings));
    assert.deepEqual(result.metrics.runtime.resourceAccesses, [
      {
        kind: "database",
        access: "read",
        selector: "app_users",
        detectedBy: "prisma-adapter",
        confidence: "medium",
      },
      {
        kind: "database",
        access: "read",
        selector: "unresolved:dynamic-sql",
        detectedBy: "prisma-adapter",
        confidence: "low",
      },
    ]);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("resource access covers decorator, route, query-builder, and repository edge forms", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-resource-edges-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src/runtime"), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, "src/runtime/public.ts"),
      [
        "declare const PrismaClient: new () => { user: { findMany(): unknown } };",
        "declare function PrismaFactory(): unknown;",
        "const prisma = new PrismaClient();",
        "const ignoredPrisma = new (PrismaFactory as never)();",
        "declare function pgTable(tableName: string): unknown;",
        "const users = pgTable('users');",
        "declare function Entity(options?: unknown): ClassDecorator;",
        "@Entity({ name: 'app_users' })",
        "class User {}",
        "declare function getRepository(entity: unknown): { find(): unknown };",
        "declare function createQueryBuilder(): { from(tableName: string, alias: string): unknown };",
        "declare const tableName: string;",
        "declare const UnknownEntity: unknown;",
        "declare const getDb: unknown;",
        "declare const db: { select: { from(table: unknown): unknown }, insert(table: unknown): unknown };",
        "declare const server: { route(config: unknown): void };",
        "declare const producer: { send(config: unknown): void };",
        "export function runRuntime(): void {",
        "  prisma.user.findMany();",
        "  getRepository(User).find();",
        "  createQueryBuilder().from('audit_logs', 'audit');",
        "  createQueryBuilder().from(UnknownEntity, 'unknown');",
        "  createQueryBuilder().from(tableName, 'dynamic');",
        "  (getDb as { (): { select(): { from(table: unknown): unknown } } })().select().from(tableName);",
        "  db.select.from(users);",
        "  db.insert(tableName);",
        "  server.route({ path: '/status', method: 'GET' });",
        "  server.route({ url: '/single-method', method: 'post' });",
        "  server.route({ url: '/bad-method', method: 1 });",
        "  server.route({ url: '/missing-method' });",
        "  producer.send({});",
        "}",
        "",
      ].join("\n"),
    );
    writeJson(path.join(rootDir, "cellfence.manifest.json"), {
      schemaVersion: "cellfence.manifest.v1",
      cells: [{
        id: "runtime",
        ownedPaths: ["src/runtime/**"],
        publicEntry: "src/runtime/public.ts",
        publicSymbols: ["runRuntime"],
        consumes: [],
        producesArtifacts: [],
        resourceContracts: [{
          id: "runtime-database",
          kind: "database",
          access: ["read", "write"],
          selectors: ["prisma.user", "app_users", "audit_logs", "users", "unresolved:dynamic-query-builder-table", "unresolved:dynamic-drizzle-table"],
        }, {
          id: "runtime-http",
          kind: "http",
          access: ["serve"],
          selectors: ["GET /status", "POST /single-method"],
        }],
      }],
    });

    const result = checkRepository({ rootDir, manifestPath: "cellfence.manifest.json" });
    assert.equal(result.ok, true, JSON.stringify(result.findings));
    assert.ok(result.metrics.runtime.resourceAccesses.some((access) =>
      access.detectedBy === "typeorm-adapter" && access.selector === "app_users"));
    assert.ok(result.metrics.runtime.resourceAccesses.some((access) =>
      access.detectedBy === "fastify-adapter" && access.selector === "GET /status"));
    assert.ok(result.metrics.runtime.resourceAccesses.some((access) =>
      access.selector === "unresolved:dynamic-query-builder-table"));
    assert.ok(result.metrics.runtime.resourceAccesses.some((access) =>
      access.selector === "unresolved:dynamic-drizzle-table" && access.access === "write"));
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("resource access covers TypeORM selector fallback and NestJS decorator edge forms", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-resource-fallbacks-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src/runtime"), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, "src/runtime/public.ts"),
      [
        "declare const UnknownEntity: unknown;",
        "declare function getRepository(entity: unknown): { find(): unknown };",
        "declare function Controller(prefix?: string): ClassDecorator;",
        "declare function Get(path?: string): MethodDecorator;",
        "declare function factory(path?: string): MethodDecorator;",
        "@Controller('api')",
        "class ApiController {",
        "  @((Get as never))('/ignored')",
        "  ignored(): void {}",
        "  @factory('/also-ignored')",
        "  ignoredByName(): void {}",
        "}",
        "export function runRuntime(): void {",
        "  getRepository(UnknownEntity).find();",
        "  getRepository('literal_repo').find();",
        "}",
        "",
      ].join("\n"),
    );
    writeJson(path.join(rootDir, "cellfence.manifest.json"), {
      schemaVersion: "cellfence.manifest.v1",
      cells: [{
        id: "runtime",
        ownedPaths: ["src/runtime/**"],
        publicEntry: "src/runtime/public.ts",
        publicSymbols: ["runRuntime"],
        consumes: [],
        producesArtifacts: [],
        resourceContracts: [{
          id: "typeorm-fallbacks",
          kind: "database",
          access: ["read"],
          selectors: ["UnknownEntity", "literal_repo"],
        }],
      }],
    });

    const result = checkRepository({ rootDir, manifestPath: "cellfence.manifest.json" });
    assert.equal(result.ok, true, JSON.stringify(result.findings));
    assert.ok(result.metrics.runtime.resourceAccesses.some((access) =>
      access.detectedBy === "typeorm-adapter" && access.selector === "UnknownEntity" && access.confidence === "medium"));
    assert.ok(result.metrics.runtime.resourceAccesses.some((access) =>
      access.detectedBy === "typeorm-adapter" && access.selector === "literal_repo" && access.confidence === "medium"));
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("resource access covers adapter-off branches and alternate framework shapes", () => {
  const disabledRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-resource-disabled-all-"));
  try {
    fs.mkdirSync(path.join(disabledRoot, "src/runtime"), { recursive: true });
    fs.writeFileSync(
      path.join(disabledRoot, "src/runtime/public.ts"),
      [
        "declare const prisma: { user: { findMany(): unknown } };",
        "declare const fs: { readFileSync(path: string): string };",
        "export function ignored(tableName: string): unknown {",
        "  fs.readFileSync(tableName);",
        "  return prisma.user.findMany();",
        "}",
        "",
      ].join("\n"),
    );
    writeJson(path.join(disabledRoot, "cellfence.manifest.json"), {
      schemaVersion: "cellfence.manifest.v1",
      governance: {
        resourceAdapters: {
          file: "off",
          http: "off",
          queue: "off",
          "sql-literal": "off",
          prisma: "off",
          typeorm: "off",
          drizzle: "off",
          "query-builder": "off",
          bullmq: "off",
          kafkajs: "off",
          nestjs: "off",
          fastify: "off",
        },
      },
      cells: [{
        id: "runtime",
        ownedPaths: ["src/runtime/**"],
        publicEntry: "src/runtime/public.ts",
        publicSymbols: ["ignored"],
        consumes: [],
        producesArtifacts: [],
      }],
    });

    const disabled = checkRepository({ rootDir: disabledRoot, manifestPath: "cellfence.manifest.json" });
    assert.equal(disabled.ok, true, JSON.stringify(disabled.findings));
    assert.deepEqual(disabled.metrics.runtime.resourceAccesses, []);
  } finally {
    fs.rmSync(disabledRoot, { recursive: true, force: true });
  }

  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-resource-alt-shapes-"));
  try {
    fs.mkdirSync(path.join(rootDir, "src/runtime"), { recursive: true });
    fs.mkdirSync(path.join(rootDir, "prisma"), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, "prisma/schema.prisma"),
      [
        "model Account {",
        "  id Int @id",
        "  @@map(\"app_accounts\")",
        "}",
        "model Post {",
        "  id Int @id",
        "}",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(rootDir, "src/runtime/extra.ts"),
      [
        "declare const PrismaClient: new () => { account: { count(): unknown } };",
        "const cachedClient = new PrismaClient();",
        "export function cachedSchemaUse(): unknown {",
        "  return cachedClient.account.count();",
        "}",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(rootDir, "src/runtime/public.ts"),
      [
        "declare const PrismaClient: new () => { account: { create(input: unknown): unknown, count(): unknown, unknownMethod(): unknown }, post: { findFirst(): unknown } };",
        "const dbClient = new PrismaClient();",
        "declare function pgTable(tableName: string): unknown;",
        "const users = pgTable('users');",
        "const ignoredTableFactory = (pgTable)('ignored');",
        "declare const db: { insert(table: unknown): unknown, update(table: unknown): unknown, delete(table: unknown): unknown };",
        "declare const tableName: unknown;",
        "declare function Entity(options?: unknown): ClassDecorator;",
        "@Entity()",
        "class PlainEntity {}",
        "declare function getRepository(entity: unknown): { save(input: unknown): unknown, find(): unknown };",
        "declare function createQueryBuilder(): { delete(): { from(table: unknown, alias?: string): unknown }, insert(): { into(table: unknown): unknown }, update(table: unknown): unknown };",
        "declare const queryDb: { selectFrom(table: unknown): unknown, insertInto(table: unknown): unknown, updateTable(table: unknown): unknown, deleteFrom(table: unknown): unknown };",
        "declare function Controller(path?: string): ClassDecorator;",
        "declare function Get(path?: string): MethodDecorator;",
        "declare function Other(): MethodDecorator;",
        "@Controller()",
        "class HealthController {",
        "  label = 'health';",
        "  @Get()",
        "  health(): void {}",
        "  @Get",
        "  undecoratedCall(): void {}",
        "  @Other()",
        "  ignored(): void {}",
        "}",
        "@Controller('/api')",
        "class ApiController {",
        "  @Get('/health')",
        "  health(): void {}",
        "}",
        "class PlainController {",
        "  @Get('/no-controller')",
        "  ignored(): void {}",
        "}",
        "declare const Queue: new (queueName: string) => { add(name: string, payload: unknown): void };",
        "declare const Worker: new (queueName: string, processor: unknown) => unknown;",
        "const jobs = new Queue('jobs');",
        "declare const server: { route(config: unknown): void };",
        "declare const config: unknown;",
        "declare const kafkaProducer: { send(config: unknown): void };",
        "declare const kafkaConsumer: { subscribe(config: unknown): void };",
        "declare const sqlClient: { query(sql: string): void };",
        "declare const fs: { readFile(path: string): string, readdirSync(path: string): string[], writeFile(path: string, data: string): void, createWriteStream(path: string): unknown };",
        "declare const eventBus: { publish(topic: string): void, subscribe(topic: string): void, receiveMessage(queue: string): void };",
        "declare const fetch: (url: string) => unknown;",
        "declare const request: (url: string) => unknown;",
        "declare const get: (path: string) => unknown;",
        "export function runRuntime(filePath: string): void {",
        "  dbClient.account.create({});",
        "  dbClient.account.count();",
        "  dbClient.account.unknownMethod();",
        "  dbClient.post.findFirst();",
        "  getRepository(PlainEntity).save({});",
        "  getRepository('literal_repo').find();",
        "  createQueryBuilder().delete().from(PlainEntity);",
        "  createQueryBuilder().insert().into('audit_logs');",
        "  createQueryBuilder().update('audit_logs');",
        "  queryDb.selectFrom('audit_logs');",
        "  queryDb.selectFrom(filePath);",
        "  queryDb.insertInto('audit_logs');",
        "  queryDb.updateTable('audit_logs');",
        "  queryDb.deleteFrom('audit_logs');",
        "  server.route({ 'url': '/multi', 'method': ['get', 'post'] });",
        "  server.route({ ...config });",
        "  server.route({ 'url': '/partial', 'method': ['get', 1] });",
        "  db.insert(users);",
        "  db.update(users);",
        "  db.delete(users);",
        "  db.select.from(tableName);",
        "  fs.writeFile(filePath, '{}');",
        "  fs.readFile('data/input.json');",
        "  fs.readdirSync('data/list');",
        "  fs.createWriteStream('data/stream.json');",
        "  fetch('https://api.example.test/fetch');",
        "  request('https://api.example.test/v1');",
        "  get('/local');",
        "  jobs.add('run', {});",
        "  new Worker('jobs', () => undefined);",
        "  kafkaProducer.send({ topic: 'orders.created' });",
        "  kafkaConsumer.subscribe({ topic: 'orders.created' });",
        "  sqlClient.query('select * from app_users');",
        "  const dynamicSql = 'select * from ' + filePath;",
        "  sqlClient.query(dynamicSql);",
        "  eventBus.publish('domain.events');",
        "  eventBus.subscribe('domain.events');",
        "  eventBus.receiveMessage('domain.queue');",
        "}",
        "",
      ].join("\n"),
    );
    writeJson(path.join(rootDir, "cellfence.manifest.json"), {
      schemaVersion: "cellfence.manifest.v1",
      cells: [{
        id: "runtime",
        ownedPaths: ["src/runtime/**"],
        publicEntry: "src/runtime/public.ts",
        publicSymbols: ["runRuntime"],
        consumes: [],
        producesArtifacts: [],
        resourceContracts: [{
          id: "runtime-database",
          kind: "database",
          access: ["read", "write"],
          selectors: ["app_accounts", "Post", "PlainEntity", "literal_repo", "audit_logs", "users", "app_users", "unresolved:dynamic-sql", "unresolved:dynamic-drizzle-table", "unresolved:dynamic-query-builder-table"],
        }, {
          id: "runtime-http",
          kind: "http",
          access: ["call", "serve"],
          selectors: ["https://api.example.test/v1", "https://api.example.test/fetch", "GET /", "GET /api/health", "GET /local", "GET /multi", "GET /partial", "POST /multi"],
        }, {
          id: "runtime-file",
          kind: "file",
          access: ["read", "write"],
          selectors: ["unresolved:dynamic-file-path", "data/input.json", "data/list", "data/stream.json"],
        }, {
          id: "runtime-queue",
          kind: "queue",
          access: ["publish", "subscribe"],
          selectors: ["domain.events", "domain.queue", "bullmq:jobs", "kafka:orders.created"],
        }],
      }],
    });

    const result = checkRepository({ rootDir, manifestPath: "cellfence.manifest.json" });
    assert.equal(result.ok, true, JSON.stringify(result.findings));
    assert.ok(result.metrics.runtime.resourceAccesses.some((access) =>
      access.detectedBy === "prisma-adapter" && access.selector === "app_accounts" && access.access === "write"));
    assert.ok(result.metrics.runtime.resourceAccesses.some((access) =>
      access.detectedBy === "prisma-adapter" && access.selector === "app_accounts" && access.access === "read"));
    assert.ok(result.metrics.runtime.resourceAccesses.some((access) =>
      access.detectedBy === "typeorm-adapter" && access.selector === "PlainEntity" && access.access === "write"));
    assert.ok(result.metrics.runtime.resourceAccesses.some((access) =>
      access.detectedBy === "typeorm-adapter" && access.selector === "literal_repo" && access.access === "read"));
    assert.ok(result.metrics.runtime.resourceAccesses.some((access) =>
      access.detectedBy === "query-builder-adapter" && access.selector === "audit_logs" && access.access === "write"));
    assert.ok(result.metrics.runtime.resourceAccesses.some((access) =>
      access.detectedBy === "query-builder-adapter" && access.selector === "unresolved:dynamic-query-builder-table" && access.access === "read"));
    assert.ok(result.metrics.runtime.resourceAccesses.some((access) =>
      access.detectedBy === "drizzle-adapter" && access.selector === "users" && access.access === "write"));
    assert.ok(result.metrics.runtime.resourceAccesses.some((access) =>
      access.detectedBy === "drizzle-adapter" && access.selector === "unresolved:dynamic-drizzle-table" && access.access === "read"));
    assert.ok(result.metrics.runtime.resourceAccesses.some((access) =>
      access.detectedBy === "nestjs-adapter" && access.selector === "GET /"));
    assert.ok(result.metrics.runtime.resourceAccesses.some((access) =>
      access.detectedBy === "nestjs-adapter" && access.selector === "GET /api/health"));
    assert.ok(result.metrics.runtime.resourceAccesses.some((access) =>
      access.detectedBy === "fastify-adapter" && access.selector === "POST /multi"));
    assert.ok(result.metrics.runtime.resourceAccesses.some((access) =>
      access.detectedBy === "file-call" && access.selector === "unresolved:dynamic-file-path" && access.access === "write"));
    assert.ok(result.metrics.runtime.resourceAccesses.some((access) =>
      access.detectedBy === "bullmq-adapter" && access.selector === "bullmq:jobs" && access.access === "publish"));
    assert.ok(result.metrics.runtime.resourceAccesses.some((access) =>
      access.detectedBy === "kafkajs-adapter" && access.selector === "kafka:orders.created" && access.access === "subscribe"));
    assert.ok(result.metrics.runtime.resourceAccesses.some((access) =>
      access.detectedBy === "receiveMessage" && access.access === "subscribe"));
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
