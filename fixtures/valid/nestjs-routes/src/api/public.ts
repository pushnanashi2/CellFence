declare function Controller(path: string): ClassDecorator;
declare function Get(path?: string): MethodDecorator;
declare function Post(path?: string): MethodDecorator;

@Controller("users")
export class UsersController {
  @Get(":id")
  getUser(): void {}

  @Post()
  createUser(): void {}
}
