"""Adapters onto other people's execution seams.

`almanak.py` lands in P5. The seam it implements is the gRPC `ExecutionService`
(`CompileIntent`, `Execute`, `GetTransactionStatus`) that every Almanak strategy already
talks to via `almanak.framework.gateway_client.GatewayClient`; see docs/VERIFIED.md.
"""
