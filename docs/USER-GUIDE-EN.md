# Planning Poker – User Guide

This guide describes the current behavior of [planning-poker.at](https://planning-poker.at/). Story Points express relative size; they are not a universal conversion to hours or days.

## Quick start

1. Enter your display name and a room code.
2. As host, use the link button beside the room code to share an invitation.
3. Configure the estimation topic, deck, special cards and automatic reveal as needed.
4. Everyone currently participating selects a card privately. A selection can be changed until reveal.
5. The host reveals the cards and starts a new round after the discussion.

There is no public room directory. Keep the link or room code if you want to return.

## Interface and settings

The room view contains room information, an optional current topic, the participant list, results and the voting grid. Host actions appear only with the required permission.

- **Desktop:** language and appearance controls are in the header.
- **Phone:** language and appearance controls are in the menu.
- **Appearance:** Light, Dark or System.
- **Estimation topic:** the host can show, edit or remove a title and optional ticket link.
- **Automatic reveal:** cards are revealed once every active participant eligible to vote has selected a regular estimate. Spectators and inactive participants are excluded; special cards do not trigger automatic reveal.

## Card decks

| Deck | Values |
|---|---|
| Fibonacci (Scrum basic) | `1, 2, 3, 5, 8, 13, 20, 40` |
| Fibonacci (Scrum enhanced) | `0, ½, 1, 2, 3, 5, 8, 13, 20, 40, 100, ∞` |
| Fibonacci (mathematical) | `0, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89` |
| Powers of 2 | `2, 4, 8, 16, 32, 64, 128` |
| T-shirt sizes | `XXS, XS, S, M, L, XL, XXL, XXXL` |

In a numeric deck, `5` represents more relative effort or complexity than `3`. The team decides which comparison tasks give those values practical meaning.

The question-mark card signals an unclear estimate. The host can additionally enable coffee (break), speech bubble (separate discussion), telescope (spike/exploration), waiting (prerequisite), link (dependency), warning (risk) and target (relevance/alignment). Special cards are not numeric and are excluded from average, median and range.

## Participant status

- A neutral hourglass means an active participant has not selected a card yet.
- After a private vote, a marker shows only that a vote exists; its value stays hidden until reveal.
- After reveal, the selected card is shown.
- A neutral dash identifies a spectator without a vote.
- Inactive or disconnected participants are visually muted and do not actively take part in voting.

## Results

Only numeric votes from active participants currently taking part are considered:

- **Average:** arithmetic mean.
- **Median:** middle value of the sorted votes; shown from two numeric votes.
- **Range:** lowest through highest value; shown from two numeric votes.
- **Consensus:** all considered numeric votes are equal and at least one numeric vote exists. Infinity prevents consensus; other special cards are not treated as numeric votes.

A round containing only special cards has no numeric statistics and no consensus. One numeric vote combined with Infinity is not consensus either.

After reveal, a subtle outline may highlight an estimate furthest from the average. Only numeric votes count. Outliers are evaluated from three numeric votes. A uniquely furthest estimate is highlighted; equally furthest estimates are highlighted only from five numeric votes. Equal estimates have no marker. The marker is a discussion aid, not a judgment.

## Roles and permissions

The host can reveal cards, start a new round, manage room options and the estimation topic, and close the room for everyone. In the three-dot menu for another eligible participant, the host can transfer the host role, toggle spectator status or remove that participant. The server authorizes these actions; guests and spectators cannot use host actions, and invalid self-actions are not offered.

Active participants can vote. Spectators follow without voting and can enable “Participate” in their own menu. The host can also change their status. The status is retained when reconnecting with the same existing participant identity.

If the host actually leaves or does not return, the room lifecycle can transfer the role. A former host does not automatically reclaim it after returning later.

## Connection, return and room data

The app synchronizes through WebSocket and automatically attempts to reconnect after short interruptions. Refresh, Back navigation or reopening in the same browser can restore the same participation, including its vote and spectator status. The browser stores a room-specific resume proof for this purpose; the display name alone is insufficient.

If durable browser storage is blocked, the app shows a notice and recovery may be limited to the current tab or page lifetime. After “Leave room”, removal by the host or room closure, the old proof is invalid. A server deployment can also interrupt active rooms and require a deliberate new join.

Room lifetime and recoverability depend on server configuration. The server can persist room snapshots, but this does not guarantee a retention period. Planning Poker is not an authoritative ticket or results archive.

On public pages, a “Return to room” link can appear in the same browser tab while a valid return target is stored. “Leave room” exits only your session. The host action “Close room for everyone” ends the session for everyone.

## Keyboard operation

There are no global number, reveal or reset shortcuts.

- Buttons and cards: focus with `Tab`; activate with `Enter` or `Space`.
- Menus: `Escape` closes them; the participant action menu also supports arrow keys, `Home` and `End`.
- Topic editor: `Enter` saves and `Escape` cancels.

## Troubleshooting

- **Cannot select a card:** check spectator status and connection; after reveal, wait for the next round.
- **Changes are missing:** verify the room code, allow reconnection to complete or reload. Proxies/firewalls may block WebSocket.
- **Name already in use:** display names alone are not identities. Use the existing invitation and browser session or choose a unique name.
- **Participation cannot be resumed:** deliberately join again through the invitation. An old proof or one issued for another room cannot be transferred.

## Example round

A team opens a room, enters a user story as the estimation topic and selects Fibonacci (Scrum basic). Every active participant votes privately while a spectator follows without voting. After reveal, the team discusses different values and starts another round. Results are recorded in the relevant issue tracker when needed.

## Glossary

| Term | Meaning |
|---|---|
| Story Points | team-specific relative size, not a fixed unit of time |
| Host | participant with room control and administration permissions |
| Spectator | participant who follows the room without voting |
| Consensus | agreement among considered numeric votes under the rules above |
| Special card | deliberately selected non-numeric signal that discussion is needed |

## Help and links

- [Application](https://planning-poker.at/)
- [Source and issues](https://github.com/nox-vobiscum/planning-poker)
- [Documentation index](INDEX.md)

Last updated: October 2026
