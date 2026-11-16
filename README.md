Board Game Collection & Play Tracker

A personal catalog for the board games you own and a play log for the sessions you play. The project is intended to bring collection details, BoardGameGeek (BGG) information, players, results, and session notes together in one place.


## Goals

- Keep an accurate, searchable record of owned board games.
- Reduce manual data entry by importing game details from BoardGameGeek when available.
- Record each playthrough, including who played, how the game ended, scores, and useful context.
- Make it easy to look back at plays, compare results, and see how often games reach the table.
- Keep imported reference information distinct from personal collection details and play history.

## Planned features

### Collection catalog

- Add a game by searching its title or entering its BGG ID.
- Import available BGG details such as the canonical title, year published, player-count range, playing time, age recommendation, categories, mechanics, description, designer, publisher, and BGG link.
- Review imported details before saving them, and allow personal corrections where appropriate.
- Track ownership-specific information separately: owned status, edition, condition, language, acquisition date, price, location, and notes.
- Search, sort, and filter the collection by title, player count, play time, category, mechanic, ownership status, and other available details.
- Support expansions and standalone games, with a way to associate an expansion with its base game.

### Play logging

Each playthrough is a separate record associated with a game. A play record can include:

- Date and, optionally, start time and duration.
- Location or venue, such as home, a game night, or a convention.
- The players involved, including a host or other session roles if useful.
- Scores and player-specific results, including winner, placement, team, or tie status.
- Session-level details such as play count, game mode, scenario, round, difficulty, or variants used.
- Which expansions or modules were used.
- Notes about the session, memorable moments, or house rules.

The exact fields can vary by game. Some games need a simple winner and final score; others benefit from teams, multiple scoring categories, cooperative outcomes, or scenario-specific details. The data model should allow optional game-specific metadata without making a basic log cumbersome.

### Players and history

- Maintain reusable player profiles so names do not need to be re-entered for every play.
- Allow a player to be marked as a guest or represented by a display name without requiring a full account.
- View an individual's play history, games played, wins, and other recorded results.
- Keep player statistics descriptive and configurable; statistics should be based only on the plays and scoring details actually recorded.

### Collection and play insights

Potential views and summaries include:

- Plays by game, player, date range, or location.
- Most-played and least-played games.
- Recent plays and games that have not been played recently.
- Player counts and typical session duration based on logged sessions.
- Results and win rates where the recorded game format makes them meaningful.

## BoardGameGeek data

BGG is the source for external game reference data; the collection and play history are personal records owned by this application. A game should retain its BGG identifier and link when one is available, so imported information can be matched to the correct listing and revisited later.

