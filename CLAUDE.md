# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Run Commands

- Build: `pnpm build` (TypeScript compilation)
- Start: `pnpm start` (run main application)
- Dev: `pnpm dev` (run with file watching)
- Telegram Monitor: `pnpm telegram:monitor`
- Position Monitor: `pnpm position:monitor`
- Type Check: `tsc --noEmit`

## Code Style Guidelines

- **TypeScript**: Strict mode enabled, target ES2020, ESM modules
- **Imports**: Sort imports by external then internal, group by type
- **Error Handling**: Use try/catch with detailed error logging
- **Services**: Implement as classes with clear interfaces
- **Types**: Define interfaces for all complex objects in `/types` directory
- **Async Code**: Use async/await pattern with proper error handling
- **Naming**:
  - CamelCase for variables/methods
  - PascalCase for classes/interfaces
  - Use descriptive names for functions and variables
- **Architecture**: Follows service-based pattern with clear separation of concerns
