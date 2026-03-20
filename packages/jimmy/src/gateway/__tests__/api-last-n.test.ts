import { describe, it, expect } from "vitest";

function filterLastN<T>(messages: T[], lastN: number): T[] {
  if (lastN > 0 && messages.length > lastN) {
    return messages.slice(-lastN);
  }
  return messages;
}

describe("filterLastN", () => {
  const messages = [1, 2, 3, 4, 5];

  it("returns last N messages when N < total", () => {
    expect(filterLastN(messages, 3)).toEqual([3, 4, 5]);
  });

  it("returns all messages when N >= total", () => {
    expect(filterLastN(messages, 10)).toEqual([1, 2, 3, 4, 5]);
  });

  it("returns all when N equals total", () => {
    expect(filterLastN(messages, 5)).toEqual([1, 2, 3, 4, 5]);
  });

  it("returns all when N is 0 (no filtering)", () => {
    expect(filterLastN(messages, 0)).toEqual([1, 2, 3, 4, 5]);
  });

  it("returns all when N is negative", () => {
    expect(filterLastN(messages, -1)).toEqual([1, 2, 3, 4, 5]);
  });

  it("returns last 1 message", () => {
    expect(filterLastN(messages, 1)).toEqual([5]);
  });

  it("handles empty array", () => {
    expect(filterLastN([], 3)).toEqual([]);
  });
});
