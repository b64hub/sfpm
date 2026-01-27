# SFPM - Salesforce Package Manager
<div align="center">
<svg width="500" height="160" xmlns="http://www.w3.org/2000/svg">
  <style>
    /* Using a specific monospace stack for better character alignment */
    .base { font-family: 'Courier New', Courier, monospace; font-size: 18px; white-space: pre; }
    .blue { fill: #5B9BD5; }
    .purple { fill: #8E44AD; }
  </style>
  <text x="10" y="20" class="base">
    <tspan x="10" dy="1.2em" class="blue">███████<tspan class="purple">╗</tspan>███████<tspan class="purple">╗</tspan>██████<tspan class="purple">╗</tspan> ███<tspan class="purple">╗</tspan>   ███<tspan class="purple">╗</tspan></tspan>
    <tspan x="10" dy="1.2em" class="blue">██<tspan class="purple">╔════╝</tspan>██<tspan class="purple">╔════╝</tspan>██<tspan class="purple">╔══</tspan>██<tspan class="purple">╗</tspan>████<tspan class="purple">╗</tspan> ████<tspan class="purple">║</tspan></tspan>
    <tspan x="10" dy="1.2em" class="blue">███████<tspan class="purple">╗</tspan>█████<tspan class="purple">╗</tspan>  ██████<tspan class="purple">╔╝</tspan>██<tspan class="purple">╔</tspan>████<tspan class="purple">╔</tspan>██<tspan class="purple">║</tspan></tspan>
    <tspan x="10" dy="1.2em" class="blue"><tspan class="purple">╚════</tspan>██<tspan class="purple">║</tspan>██<tspan class="purple">╔══╝</tspan>  ██<tspan class="purple">╔═══╝</tspan> ██<tspan class="purple">║╚</tspan>██<tspan class="purple">╔╝</tspan>██<tspan class="purple">║</tspan></tspan>
    <tspan x="10" dy="1.2em" class="blue">███████<tspan class="purple">║</tspan>██<tspan class="purple">║</tspan>     ██<tspan class="purple">║</tspan>     ██<tspan class="purple">║</tspan> <tspan class="purple">╚═╝</tspan> ██<tspan class="purple">║</tspan></tspan>
    <tspan x="10" dy="1.2em" class="purple">╚══════╝╚═╝     ╚═╝     ╚═╝     ╚═╝</tspan>
  </text>
</svg>
</div>

## Development Context

This project uses **pnpm** for package management. Please do not use `npm` or `yarn`.

### Commands
- Install dependencies: `pnpm install`
- Build: `pnpm build` (or specific package scripts)
- Test: `pnpm test`

## Introduction

SFPM (Salesforce Package Manager) is a CLI-based utility designed to streamline the deployment, retrieval, and management of Salesforce metadata packages.

## Features

Feature A: Quick description.

Feature B: Quick description.

Feature C: Quick description.

## Installation

Example installation command
```
npm install -g sfpm-cli
```

## Quick Start / Usage

Provide the most common command so users can get started in seconds.

```
sfpm deploy --path ./force-app
```

## Configuration

Explain any .sfpmrc or environment variables needed (e.g., Auth tokens, Org aliases).

## Commands
Command	Description
```
sfpm init	Initialize a new project
sfpm push	Push local changes to the scratch org
sfpm fetch	Retrieve metadata from a sandbox
```

## Contributing

Briefly mention how others can submit PRs or report bugs.

## License

Distributed under the MIT License. See LICENSE for more information.