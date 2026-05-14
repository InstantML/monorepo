# Design: <Title>

Date: YYYY-MM-DD

Status: Draft

Owner: <name or agent>

## Summary

Describe the change in a few paragraphs. Explain the user problem, the proposed solution, and the smallest useful version.

## Goals

- Goal 1
- Goal 2
- Goal 3

## Non-Goals

- Non-goal 1
- Non-goal 2

## Users and Use Cases

Describe who uses this and the concrete workflow it supports.

## Proposed Design

Explain the design in enough detail for another agent to implement it without guessing.

## Component Impact

Backend:

- Impact

Frontend:

- Impact

Python SDK:

- Impact

Storage:

- Impact

Docs:

- Impact

## Data Model

List new or changed entities, fields, indexes, and relationships.

## API Contracts

List new or changed endpoints, SDK methods, request/response shapes, and error behavior.

## Performance Considerations

Document:

- Expected rows/items per user action
- Expected write frequency
- Expected read/query shape
- Latency target
- Pagination, limits, or streaming behavior
- Indexes and why they are needed
- Memory concerns
- Batching needs
- Measurement or profiling plan

List endpoints should return summaries only. Metric history should be fetched through bounded endpoints filtered by run, key, step range, time range, or explicit limit. Artifact upload/download paths should not share the scalar metric hot path.

## Simplicity Review

Explain why this design is the simplest useful version. List any complexity that was intentionally deferred.

## Failure Modes

Describe what can fail and how the system should behave.

## Testing Plan

List unit, integration, API, SDK, frontend, and importer tests. Explain how the change will preserve 100% first-party code coverage or document any temporary exception.

## Documentation Plan

List README files and docs that must be updated with the implementation.

## Alternatives Considered

Describe simpler or more complex alternatives and why they were rejected.

## Review Notes

Fresh reviewer 1:

- Finding:
- Risk:
- Recommended edit:
- Decision:

Fresh reviewer 2:

- Finding:
- Risk:
- Recommended edit:
- Decision:

## Coverage Exceptions

Use this section only when full meaningful first-party coverage is temporarily unreasonable.

- Uncovered area:
- Reason:
- Risk:
- Follow-up:
- Owner/date:

## Decision

Record whether this design is accepted, rejected, or revised before implementation starts.
