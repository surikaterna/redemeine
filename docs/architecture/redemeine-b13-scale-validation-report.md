# redemeine-b13 Scale Validation Report

## Scenario
- Seed: 13
- Horizon: 1440 minutes (24h representative simulation)
- Base arrivals/minute: 160
- Scheduler max decisions/minute: 165
- Target: 200,000 sagas/day

## Throughput envelope
- Arrived: 235,091
- Selected (processed): 234,049
- Projected sagas/day from average throughput: 234,043
- Final backlog after horizon: 1,042
- Throughput min/avg/p95/max per minute: 149/162.53/165/165
- Minutes at or above target rate (138.89 per minute): 1440/1440

## Methodology
- Model: Deterministic minute-level simulation with carry-over backlog and seeded pseudo-random arrivals
- Workload: 8-tenant mixed profile, weighted shares, periodic bursts, and recurring global spikes
- Policy coverage: fairness_weight, tenant_rate_limit, global_capacity_limit, anti_starvation_rotation

## Policy behavior under load
- Deferred due to tenant rate limits: 875,012
- Deferred due to global capacity: 118,745
- Tenants with arrivals but zero selections: none
- Worst blocked streak: tenant-enterprise-a (0 consecutive minutes with demand but no selection)

## Per-tenant stats
| Tenant | Arrived | Selected | Deferred (rate-limited) | Deferred (global cap) | Max blocked streak (minutes) |
| --- | ---: | ---: | ---: | ---: | ---: |
| tenant-enterprise-a | 71,042 | 71,042 | 1,460 | 11,172 | 0 |
| tenant-enterprise-b | 51,842 | 51,842 | 0 | 2,443 | 0 |
| tenant-growth-a | 34,782 | 34,782 | 2,205 | 23,845 | 0 |
| tenant-growth-b | 26,119 | 26,119 | 13,620 | 62,651 | 0 |
| tenant-longtail-a | 9,099 | 8,640 | 363,894 | 0 | 0 |
| tenant-longtail-b | 7,492 | 7,200 | 214,402 | 0 | 0 |
| tenant-smb-a | 18,828 | 18,592 | 200,168 | 18,634 | 0 |
| tenant-smb-b | 15,887 | 15,832 | 79,263 | 0 | 0 |
