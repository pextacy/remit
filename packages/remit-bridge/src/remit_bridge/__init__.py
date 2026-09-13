"""Remit bridge.

Phase 0 ships the package boundary and the pinned Almanak dependency, nothing else.
The gateway adapter, the KeeperHub client and the receipt chain land in P3 and P5
(PLAN.md 2.3-2.4, 3.1-3.2). They are absent rather than stubbed on purpose: a function
body that returns a plausible value is the failure this project exists to remove
(CLAUDE.md §2.1).
"""

__all__ = ["__version__"]

__version__ = "0.0.0"
