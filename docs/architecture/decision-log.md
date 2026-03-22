---
title: "Architecture Decision Record: Mixins vs. Classes"
last_updated: 2026-03-22
status: stable
ai_priority: high
---

# Architecture Decision Record: Mixins vs. Classes

## Summary
This document outlines the architectural decision to transition from prototype-based class mutation (used in the legacy `demeine` framework) to a functional, package-based Mixin architecture in Redemeine. By leveraging `createAggregateBuilder` and composable Mixins, we achieve strict end-to-end TypeScript inference, eliminate prototype pollution, and allow complex aggregates (like `Shipment` extending `Order`) to be composed predictably without creating tightly coupled "God Objects."