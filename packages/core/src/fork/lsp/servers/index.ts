import type { LSPServer } from "../server.js"
import { Biome, Astro, BashLS, Deno, DockerfileLS, ESLint, Oxlint, PHPIntelephense, Prisma, Svelte, Typescript, Vue, YamlLS } from "./web.js"
import { Clojure, Dart, Gleam, Gopls, HLS, JuliaLS, Nixd, Ocaml, Pyright, Rubocop, RustAnalyzer, SourceKit, Ty } from "./native.js"
import {
  Clangd,
  CSharp,
  ElixirLS,
  FSharp,
  JDTLS,
  KotlinLS,
  LuaLS,
  Razor,
  TerraformLS,
  TexLab,
  Tinymist,
  Zls,
} from "./managed.js"

/**
 * Every built-in server. The order is the order servers are tried for a file, and so the order their
 * diagnostics are merged in.
 */
export const builtIns: readonly LSPServer.Info[] = [
  Deno,
  Typescript,
  Vue,
  ESLint,
  Oxlint,
  Biome,
  Gopls,
  Rubocop,
  Ty,
  Pyright,
  ElixirLS,
  Zls,
  CSharp,
  Razor,
  FSharp,
  SourceKit,
  RustAnalyzer,
  Clangd,
  Svelte,
  Astro,
  JDTLS,
  KotlinLS,
  YamlLS,
  LuaLS,
  PHPIntelephense,
  Prisma,
  Dart,
  Ocaml,
  BashLS,
  TerraformLS,
  TexLab,
  DockerfileLS,
  Gleam,
  Clojure,
  Nixd,
  Tinymist,
  HLS,
  JuliaLS,
]
