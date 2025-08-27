import { protectedProcedure, createTRPCRouter } from "@/trpc/init";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { inngest } from "@/inngest/client";
import { generateSlug } from "random-word-slugs";
import { TRPCError } from "@trpc/server";
import { consumeCredits } from "@/lib/usage";


export const projectsRouter = createTRPCRouter({
  getOne: protectedProcedure
    .input(z.object({
      id: z.string().min(1, { message: "Project ID is required" }),
    }))
    .query(async ({ input, ctx }) => {
      const eproject = await prisma.project.findUnique({
        where: {
          id: input.id,
          userId: ctx.auth.userId,
        },
      });

      if (!eproject) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Project not found",
        });
      }
      return eproject;
    }),

  getMany: protectedProcedure
    .query(async ({ ctx }) => {
      const projects = await prisma.project.findMany({

        where: {
          userId: ctx.auth.userId,
        },

        orderBy: {
          updatedAt: "desc",
        },
      });

      return projects;
    }),


  delete: protectedProcedure
    .input(z.object({
      ids: z.array(z.string().min(1)),
    }))
    .mutation(async ({ input, ctx }) => {
      const { ids } = input;
      const result = await prisma.project.deleteMany({
        where: {
          id: { in: ids },
          userId: ctx.auth.userId,
        },
      });
      return { count: result.count };
    }),


  // if (!project) {
  //   throw new TRPCError({
  //     code: "NOT_FOUND",
  //     message: "Project not found",
  //   });
  // }



  create: protectedProcedure
    .input(
      z.object({
        value: z.string()
          .min(1, { message: "Value is required" })
          .max(1000, { message: "Value is too long " }),

      }),

    )
    .mutation(async ({ input, ctx }) => {

      try {
        await consumeCredits();
      } catch (error) {
        if (error instanceof Error) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Something went wrong",
          });
        }
        else {
          throw new TRPCError({
            code: "TOO_MANY_REQUESTS",
            message: "You have exceeded your free credits",
          });
        }
      }











      const createdProject = await prisma.project.create({
        data: {
          userId: ctx.auth.userId,
          name: generateSlug(2, {
            format: "kebab",

          }),
          messages: {
            create: {
              content: input.value,
              role: "USER",
              type: "RESULT",
            }
          }
        }
      });




      await inngest.send({
        name: "code-agent/run",
        data: {
          value: input.value,
          projectId: createdProject.id,
        },
      });


      return createdProject;
    }),
});