"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

interface BadgeProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: "default" | "secondary" | "destructive" | "outline" | "success" | "warning";
  pulse?: boolean;
  children: React.ReactNode;
  className?: string;
}

const variantClasses: Record<NonNullable<BadgeProps["variant"]>, string> = {
  default: "bg-primary text-primary-foreground",
  secondary: "bg-base-200 text-ink-2",
  destructive: "bg-destructive text-destructive-foreground",
  outline: "text-ink-2 shadow-[inset_0_0_0_1px_var(--color-line)]",
  success: "bg-success-tint text-success",
  warning: "bg-warning-tint text-warning",
};

export function Badge({ variant = "default", pulse = false, className, children, ...props }: BadgeProps) {
  return (
    <div className={cn("inline-flex items-center rounded border border-transparent px-2 py-0.5 text-[11px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-primary", variantClasses[variant], pulse && "animate-pulse", className)} {...props}>
      {children}
    </div>
  );
}
