import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { AgentService } from "./agent.service";
import { AgentProcessor } from "./agent.processor";
import { RevisionService } from "./revision.service";
import { WsModule } from "../ws";
import { DRIZZLE, type Db } from "../db";
import { TextService } from "../services";
import { ConversationMemoryService } from "./conversation-memory.service";
import { createDrizzleMemoryStore } from "./conversation-memory.store";

@Module({
  imports: [
    BullModule.registerQueue({
      name: "generation",
    }),
    WsModule,
  ],
  providers: [
    AgentService,
    AgentProcessor,
    RevisionService,
    {
      // 用工厂装配：把「存储」和「摘要模型」作为两个依赖注入。
      // 单测里可以直接 new ConversationMemoryService(fakeStore, fakeSummarizer)，
      // 不必拉起 Nest，也不必伪造 drizzle 的链式查询。
      provide: ConversationMemoryService,
      inject: [DRIZZLE, TextService],
      useFactory: (db: Db, textService: TextService) =>
        new ConversationMemoryService(
          createDrizzleMemoryStore(db),
          ({ system, user }) =>
            textService.generate(user, {
              systemPrompt: system,
              // 摘要是压缩任务：低温度 + 小上限，避免跑飞和浪费额度
              temperature: 0.2,
              maxTokens: 800,
              intent: "memory_summary",
            }),
        ),
    },
  ],
  exports: [AgentService],
})
export class AgentModule {}
