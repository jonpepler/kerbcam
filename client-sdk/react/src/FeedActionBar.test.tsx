/**
 * Rendered-DOM tests for `FeedActionBar` -- the actual ⋮ trigger + portaled
 * overflow menu behaviour, on top of the pure partition logic covered in
 * FeedActionBar.test.ts.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FeedActionBar, type FeedActionBarEntry } from "./FeedActionBar";

afterEach(() => {
  cleanup();
});

function makeEntry(
  id: string,
  opts: {
    stateful?: boolean;
    order?: number;
    pinnedTrailing?: boolean;
    onClick?: () => void;
  } = {},
): FeedActionBarEntry {
  return {
    id,
    label: id,
    stateful: opts.stateful,
    order: opts.order,
    pinnedTrailing: opts.pinnedTrailing,
    render: () => (
      <button type="button" aria-label={id} onClick={opts.onClick}>
        {id}
      </button>
    ),
  };
}

describe("FeedActionBar", () => {
  it("renders every entry inline (no ⋮ trigger) when below the overflow threshold", () => {
    render(
      <FeedActionBar
        entries={[makeEntry("a"), makeEntry("b"), makeEntry("c")]}
      />,
    );
    expect(screen.getByLabelText("a")).toBeTruthy();
    expect(screen.getByLabelText("b")).toBeTruthy();
    expect(screen.getByLabelText("c")).toBeTruthy();
    expect(screen.queryByLabelText("More actions")).toBeNull();
  });

  it("shows the ⋮ trigger once total >= 4 and non-stateful eligible >= 2, hiding the collapsed entries inline", () => {
    render(
      <FeedActionBar
        entries={[
          makeEntry("tracking", { stateful: true }),
          makeEntry("quality"),
          makeEntry("pip"),
          makeEntry("fullscreen"),
        ]}
      />,
    );
    // Stateful stays inline.
    expect(screen.getByLabelText("tracking")).toBeTruthy();
    // Non-stateful collapsed: not rendered inline (only inside the closed menu).
    expect(screen.queryByLabelText("quality")).toBeNull();
    expect(screen.getByLabelText("More actions")).toBeTruthy();
  });

  it("opens the portaled overflow menu on click, listing the collapsed entries", () => {
    render(
      <FeedActionBar
        entries={[
          makeEntry("tracking", { stateful: true }),
          makeEntry("quality"),
          makeEntry("pip"),
          makeEntry("fullscreen"),
        ]}
      />,
    );

    fireEvent.click(screen.getByLabelText("More actions"));

    const menu = screen.getByRole("menu", { name: "More actions" });
    expect(menu.parentElement).toBe(document.body);
    // Portaled + fixed, same contract as CameraFeed's other menus.
    expect(getComputedStyle(menu).position).toBe("fixed");
    expect(screen.getByLabelText("quality")).toBeTruthy();
    expect(screen.getByLabelText("pip")).toBeTruthy();
    expect(screen.getByLabelText("fullscreen")).toBeTruthy();
  });

  it("clicking an overflow entry fires its own onClick AND closes the overflow menu", () => {
    const onQuality = vi.fn();
    render(
      <FeedActionBar
        entries={[
          makeEntry("tracking", { stateful: true }),
          makeEntry("quality", { onClick: onQuality }),
          makeEntry("pip"),
          makeEntry("fullscreen"),
        ]}
      />,
    );

    fireEvent.click(screen.getByLabelText("More actions"));
    expect(screen.getByRole("menu", { name: "More actions" })).toBeTruthy();

    fireEvent.click(screen.getByLabelText("quality"));
    expect(onQuality).toHaveBeenCalledTimes(1);
    // The menu closes on its own after a leaf action fires, rather than
    // waiting for an outside pointerdown.
    expect(screen.queryByRole("menu", { name: "More actions" })).toBeNull();
  });

  it("never collapses a single non-stateful item even with 4+ total", () => {
    render(
      <FeedActionBar
        entries={[
          makeEntry("tracking", { stateful: true }),
          makeEntry("rec", { stateful: true }),
          makeEntry("power", { stateful: true }),
          makeEntry("quality"),
        ]}
      />,
    );
    expect(screen.getByLabelText("quality")).toBeTruthy();
    expect(screen.queryByLabelText("More actions")).toBeNull();
  });

  it("renders leading content ahead of the partitioned entries", () => {
    render(
      <FeedActionBar
        leading={<span data-testid="leading">step buttons</span>}
        entries={[makeEntry("a")]}
      />,
    );
    expect(screen.getByTestId("leading")).toBeTruthy();
  });

  it("renders nothing when there is no leading content and no entries", () => {
    const { container } = render(<FeedActionBar entries={[]} />);
    expect(container.firstChild).toBeNull();
  });
});

describe("FeedActionBar -- pinnedTrailing (close/remove)", () => {
  it("renders the pinned entry directly, never inside the ⋮ overflow menu", () => {
    // Same shape as CrewBar's per-face row: spotlight (stateful) + fullscreen
    // + pip (non-stateful) + close (pinned). Excluding "close" from the count
    // drops the non-pinned total to 3, so overflow does not even trigger --
    // fullscreen/pip stay inline, and close sits after them.
    render(
      <FeedActionBar
        entries={[
          makeEntry("spotlight", { stateful: true }),
          makeEntry("fullscreen"),
          makeEntry("pip"),
          makeEntry("close", { pinnedTrailing: true }),
        ]}
      />,
    );
    expect(screen.getByLabelText("fullscreen")).toBeTruthy();
    expect(screen.getByLabelText("pip")).toBeTruthy();
    expect(screen.getByLabelText("close")).toBeTruthy();
    expect(screen.queryByLabelText("More actions")).toBeNull();
  });

  it("is excluded from the overflow-threshold count: the remaining set can still cross it on its own", () => {
    // Tile.tsx / CameraFeed shape: spotlight + quality + tracking + pip +
    // fullscreen + remove (pinned). Excluding "remove", the remaining 5 (3
    // non-stateful) still cross 4/2, so the ⋮ appears for those three.
    render(
      <FeedActionBar
        entries={[
          makeEntry("spotlight", { stateful: true }),
          makeEntry("quality"),
          makeEntry("tracking", { stateful: true }),
          makeEntry("pip"),
          makeEntry("fullscreen"),
          makeEntry("remove", { pinnedTrailing: true }),
        ]}
      />,
    );
    expect(screen.queryByLabelText("quality")).toBeNull();
    expect(screen.queryByLabelText("pip")).toBeNull();
    expect(screen.queryByLabelText("fullscreen")).toBeNull();
    expect(screen.getByLabelText("More actions")).toBeTruthy();
    // The pinned entry is never swept into the overflow menu.
    expect(screen.getByLabelText("remove")).toBeTruthy();
  });

  it("renders as the rightmost control -- after the ⋮ trigger -- in DOM order", () => {
    render(
      <FeedActionBar
        entries={[
          makeEntry("spotlight", { stateful: true }),
          makeEntry("quality"),
          makeEntry("tracking", { stateful: true }),
          makeEntry("pip"),
          makeEntry("fullscreen"),
          makeEntry("remove", { pinnedTrailing: true }),
        ]}
      />,
    );
    const bar = screen.getByLabelText("More actions").parentElement;
    expect(bar).toBeTruthy();
    const order = Array.from(bar?.querySelectorAll("button") ?? []).map((el) =>
      el.getAttribute("aria-label"),
    );
    // "More actions" (⋮) immediately precedes "remove" (✕), and nothing
    // pinned/overflow-eligible follows it.
    expect(order.at(-2)).toBe("More actions");
    expect(order.at(-1)).toBe("remove");
  });
});
