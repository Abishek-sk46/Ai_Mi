"use client";

import { useTRPC } from "@/trpc/client";
import { useSuspenseQuery } from "@tanstack/react-query";

export const Client = () =>{
    const trcp = useTRPC();
    const { data } = useSuspenseQuery( trcp.hello.queryOptions({ text:"world"}));

    return (
        <div>
            { JSON.stringify(data) }
        </div>
    )

}