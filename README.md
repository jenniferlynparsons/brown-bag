# Brown Bag

**One book, one hour, once a week.**

Brown Bag is an Obsidian plugin for a professional library that you will never read cover to cover. Each week, you skim one book on purpose for one hour. Mortimer Adler called this method *inspectional reading*. In the hour, you find the argument of the book and mark the chapters to come back to. Then you decide what the book is worth to you.

Each book gets one of four verdicts:

- **Read deeper**
- **Keep as a reference**
- **Got what I needed**
- **Let it go**

Each book is a plain Markdown note with properties. You can read and edit your data without the plugin.

## Start here

1. Install the plugin and turn it on (see [Install](#install)).
2. Click the bag icon in the left ribbon. **This week** opens.
3. Add books with **Add book**, or put existing book notes in `Library/`.
4. Click **Pick this week's book**, then **Start the hour**.

## This week

The main view opens on **This week**: the book for this week.

- The card shows the cover, your "Why this book" note and your guiding question.
- Buttons: **Start the hour**, **Record verdict** and **Not this week**.
- **On deck** is a short queue of the next books. The hour starts with reading, not with a choice.
- If you have no book for this week, Brown Bag suggests one. You can limit the suggestion to one topic.
- **Recent sessions** shows your last sessions and their verdicts.

## The hour

**Start the hour** starts a timer with four phases:

| Phase | Minutes | What to do |
| --- | --- | --- |
| First pass | 10 | Read the cover copy, the introduction and the table of contents. Find the argument. Mark the useful chapters. |
| Openings and closings | 15 | Read the first and last paragraphs of each marked chapter. Add the good ones to *Chapters worth reading*. |
| One section, properly | 25 | Read the most useful section in full. Use your guiding question if you have one. |
| Wrap-up | 10 | Say or write the one idea to keep, where it applies now, and the next step for the book. |

- A chime and a notice mark each new phase.
- You can pause, skip to the next phase, open the book note, or stop early.
- The timer continues if you close and open Obsidian again.
- At the end of the hour, the verdict form opens.
- You can change the length of each phase in the settings.

## The verdict

The verdict form shows your "Why this book" note first. Then you can see if the book gave you what you hoped for. The form asks for:

1. The one idea worth keeping.
2. Where it applies now: a team, a project, a conversation.
3. The next step for the book: one of the four verdicts.
4. A link, if you want one (Bookpile, Goodreads or StoryGraph).

The plugin writes the verdict in the *Verdict* section and the properties of the note. The book moves to **Skimmed**.

## Book notes

Each book note has the same sections:

- **Why this book** and **Guiding question**
- **First pass**
- **Chapters worth reading** (checkboxes)
- **Notes**: a good place for a voice-note transcript or summary
- **Verdict**

A bar at the top of the note shows the status, the verdict and the next action.

## Other tabs

- **Shelf:** search by title or author. Filter by status and topic. **Find missing covers** searches Open Library for each book that has no cover.
- **Skimmed:** finished books, grouped by verdict, with the one idea for each. **Another session** puts a book on deck again.
- **Chapters:** every unchecked chapter from every skimmed book, in one list. A check here also updates the book note.
- **Topics:** add, rename and delete topics. A rename changes every book that uses the topic.

## Retros

Brown Bag treats the practice as a pilot. After every five sessions, it suggests a retro. You can change the number. The retro note in `Retros/` asks:

1. Did I keep anything?
2. Was the hour worth it?
3. What do the verdicts say about the library?
4. What changes for the next stretch?

## Year-end report

**Year-end report** makes one Markdown note for a year, in `Exports/`. It includes every book that got an hour in that year:

- A row of covers.
- A summary table: sessions, hours, books, verdicts, and chapters marked and read.
- Highlights: your longest run of weeks, your busiest month, books that got a second hour, and how much of the library you sorted.
- A log of every hour, with the date, the book and the verdict.
- Each book with its cover, sessions, "Why this book", guiding question, argument, idea, where it applies, and chapters.

Covers use HTML `<img>` tags. They show in Obsidian, on GitHub, and in most newsletter tools.

## Other exports

All exports are Markdown files in `Exports/`.

- **Skim notes since the last export:** grouped by verdict, with the one idea for each book.
- **Chapters to read:** the open chapter list.
- **Library:** a Markdown table and a CSV.

## Show a list in any note

````markdown
```brown-bag
show: week
```
````

Values for `show`:

- `week`: the book for this week and the books on deck.
- `chapters`: the chapter list, with checkboxes.
- `topic`: the books of the topic note that contains the block.
- `book`: the status bar for a book note.

## Commands

| Command | Result |
| --- | --- |
| Open this week | Opens the main view |
| Add a book to the library | Opens the add form |
| Skim this book this week | Makes the open book the book for this week |
| Put this book on deck | Adds the open book to the queue |
| Start the hour with this book | Starts the timer |
| Record a verdict for this book | Opens the verdict form |
| Why this book | Edits "Why this book" and the guiding question |
| Find a cover for this book | Searches Open Library |
| Find covers for every book that has none | Searches Open Library for all books |
| Year-end report | Makes the report for a year |
| Start a retro | Makes a retro note |

The plugin sets no hotkeys.

## Settings

- **Open Brown Bag when the vault opens:** on by default.
- **The hour:** the minutes for each phase, and a reset button.
- **Suggest a retro every:** 5 sessions by default. Type 0 to stop the suggestion.
- **Folders:** Library, Topics, Exports and Retros.

## Book properties

| Property | Values |
| --- | --- |
| `title`, `author` | text |
| `cover`, `link` | URLs |
| `status` | `shelf`, `on deck`, `skimming`, `skimmed` |
| `verdict` | `read deeper`, `reference`, `got what I needed`, `let it go` |
| `idea` | the one idea worth keeping |
| `topics` | list of links |
| `sessions` | the date of each session |
| `decked`, `skimmed` | dates |

## Network use

Brown Bag connects to [Open Library](https://openlibrary.org) only when you search for a cover. Cover images load from the URL in each note. The plugin has no accounts, no telemetry and no ads. It does not change files outside your vault.

## Install

**Manual install:**

1. Download `main.js`, `manifest.json` and `styles.css` from the latest release.
2. Put them in `<your vault>/.obsidian/plugins/brown-bag/`.
3. In Obsidian, open **Settings → Community plugins** and turn on **Brown Bag**.

**With BRAT:** add `jenniferlynparsons/brown-bag` as a beta plugin.

The plugin works on desktop and mobile. On a phone, the chime plays only while Obsidian is open.

## License

MIT
