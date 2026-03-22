---
title: "Strict Domain Contracts with Zod"
last_updated: 2026-03-22
status: stable
ai_priority: high
---

# Strict Domain Contracts with Zod

## Summary
This guide explains how to define and enforce immutable, runtime-validated schemas for your Domain using Zod. It covers the best practices for structuring your `contract.ts` files, separating State, Commands, and Events into distinct namespaces. By binding these Zod schemas to the Redemeine builders, developers ensure that invalid data is caught at the boundary before it ever reaches the Command Processors or Event Applyers.