
"use client";

import { toast } from "sonner";
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useTRPC } from "@/trpc/client";
import { useRouter } from "next/navigation";

const Page = () => {
  const router = useRouter();
  const [value, setValue] = useState("");

  const trpc = useTRPC();
  const createProject = useMutation(trpc.projects.create.mutationOptions({
    onError: (error) => {
      toast.error("Error creating project: " + error.message);
    },
    onSuccess: (data) => {
      router.push(`/projects/${data.id}`);
    }
  }));



  return (
    <div className="h-screen w-screen flex items-center justify-center">
      <div className="max-w-7xl mx-auto flex items-center flex-col gap-y-4 justify-center">
        <Input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Enter text for background job"

        />
        <Button
          disabled={createProject.isPending}
          onClick={() => { createProject.mutate({ value: value }) }}
          className="mt-4"
        >
          Submit
        </Button>
      </div>
    </div>
  );
}

export default Page;