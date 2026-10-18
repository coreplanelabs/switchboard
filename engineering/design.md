## Software design

- Apply SOLID to real boundaries: give each module one coherent responsibility; use existing extension points for variants; preserve shared contracts across implementations, including errors and effects; expose only the operations each consumer needs; keep policy separate from infrastructure through established interfaces.
- Prefer composition and explicit dependencies. Add an abstraction for a demonstrated need. Keep coupled decisions together and remove duplicated knowledge. Express intent in names and structure. Choose the simplest design that satisfies the required behavior.
- Tidy first when a small structural change makes the task easier. Keep structural and behavioral changes in separate, coherent commits. Preserve observable behavior during refactoring and verify it before and after. Use small, reversible steps; do not make unrelated cleanup a prerequisite.
