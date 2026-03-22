---
title: "Path-Aware Naming Conventions"
last_updated: 2026-03-22
status: stable
ai_priority: high
---

# Path-Aware Naming Conventions

## Summary
A comprehensive guide to Redemeine's "Targeted Naming" engine. This document details the automated routing rules that transform standard camelCase method calls into strict, dot-notation strings for your event store. It explains the core `aggregate.entity.action` pattern (e.g., mapping an `OrderLine`'s `amendProductType` command to `order.order_line.product_type.amended.event`) and how to use the `.overrideEventNames()` fallback for legacy compatibility.