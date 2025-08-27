
"use client";
import React from "react";

import Link from "next/link";
import Image from "next/image";
import { useUser } from "@clerk/nextjs";
import { formatDistanceToNow } from "date-fns";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

import { useTRPC } from "@/trpc/client";
import { Button } from "@/components/ui/button";

export const ProjectList = () =>{
    const trpc = useTRPC();
    const queryClient = useQueryClient();
    const { user } = useUser();
    const { data: projects } = useQuery(trpc.projects.getMany.queryOptions());
    const [selected, setSelected] = React.useState<string[]>([]);
    const deleteMutation = useMutation(trpc.projects.delete.mutationOptions({
        onSuccess: () => {
            setSelected([]);
            queryClient.invalidateQueries(trpc.projects.getMany.queryOptions());
        },
    }));
    const handleDelete = () => {
        if (selected.length > 0) {
            deleteMutation.mutate({ ids: selected });
        }
    };

    if (!user) return null;

    const handleSelect = (id: string) => {
        setSelected((prev) =>
            prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
        );
    };



    return (
        <div className="w-full bg-white dark:bg-sidebar rounded-xl p-8 border flex flex-col gap-y-6 sm:gap-y-4">
            <h2 className="text-2xl font-semibold">
                {user?.firstName}&apos;s Vibes
            </h2>
            <div className="mb-4">
                <Button
                    variant="destructive"
                    disabled={selected.length === 0 || deleteMutation.isPending}
                    onClick={handleDelete}
                >
                    Delete Selected
                </Button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
                {projects?.length === 0 && (
                    <div className="col-span-full text-center">
                        <p className="text-sm text-muted-foreground">No projects found</p>
                    </div>
                )}
                {projects?.map((project) => (
                    <div key={project.id} className="relative">
                        <input
                            type="checkbox"
                            checked={selected.includes(project.id)}
                            onChange={() => handleSelect(project.id)}
                            className="absolute top-2 left-2 z-10"
                        />
                        <Button
                            variant="outline"
                            className="font-normal h-auto justify-start w-full text-start p-4"
                            asChild
                        >
                            <Link href={`/projects/${project.id}`}>
                                <div className="flex items-center gap-x-4">
                                    <Image
                                        src="/logo.svg"
                                        alt="Project Icon"
                                        width={32}
                                        height={32}
                                        className="object-contain"
                                    />
                                    <div className="flex flex-col">
                                        <h3 className="truncate font-medium">{project.name}</h3>
                                        <p className="text-sm text-muted-foreground">
                                            {formatDistanceToNow(project.updatedAt, {
                                                addSuffix: true,
                                            })}
                                        </p>
                                    </div>
                                </div>
                            </Link>
                        </Button>
                    </div>
                ))}
            </div>
        </div>
    );
};