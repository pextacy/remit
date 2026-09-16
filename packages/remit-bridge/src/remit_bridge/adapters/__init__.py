"""Adapters onto other people's execution seams.

`almanak.py` lands in P5. The seam it implements is the gRPC `ExecutionService`
(`CompileIntent`, `Execute`, `GetTransactionStatus`) that every Almanak strategy already
talks to via `almanak.framework.gateway_client.GatewayClient`, read from the pinned
SDK in this package's lockfile rather than from memory.
"""
