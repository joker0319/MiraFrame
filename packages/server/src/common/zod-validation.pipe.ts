import { BadRequestException, Injectable, type PipeTransform } from "@nestjs/common";
import type { ZodTypeAny } from "zod";

/**
 * Nest 的 Zod 入参管道。
 *
 * 只做两件事：safeParse、把 issue 压缩成前端能读的 400。
 * 空 body 按 `{}` 处理，兼容「所有字段都可选」的命令接口。
 */
@Injectable()
export class ZodValidationPipe implements PipeTransform {
  constructor(private readonly schema: ZodTypeAny) {}

  transform(value: unknown): unknown {
    const result = this.schema.safeParse(value ?? {});
    if (result.success) return result.data;

    throw new BadRequestException({
      message: "请求参数不合法",
      issues: result.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }
}
