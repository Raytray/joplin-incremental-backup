# Security policy

## Supported versions

Only the latest release gets security fixes. Update the plugin from Joplin's plugin manager before reporting.

## Reporting a vulnerability

Please report security problems privately through GitHub: go to the [Security tab](https://github.com/Raytray/joplin-incremental-backup/security) and choose **Report a vulnerability**. Don't open a public issue.

Include the plugin and Joplin versions, your OS, and steps to reproduce. Leave out any personal notes or backup contents.

This is a one-person project, so I can't promise response times. I aim to reply within a week.

## Scope

In scope: anything in this repository, for example:

- the plugin reading or writing files outside the chosen backup and staging directories
- snapshot data being exposed or corrupted
- problems in the release pipeline or the published npm package

Joplin's own vulnerabilities go to the [Joplin project](https://github.com/laurent22/joplin/security).
