**Botdog commands** - current version: v{{VERSION}}

**v1.0 - Auto-archiver** *(privileged role only)*
--------------------
`/arc on <channel>` - Turn archiving back on for a channel
`/arc off <channel>` - Exclude a channel from archiving
`/arc days <channel> <n>` - Set how many days of inactivity before a channel is archived
`/arc status [channel]` - Show one channel's archive settings, or all of them
`/arc all <on|off>` - Master switch for archiving across the whole server

**v1.2 - Restore**
--------------------
`/arc restore [channel]` - Move an archived channel back to its home category (blank = this channel) *(privileged role only)*

**v1.3 - Gaming sessions**
--------------------
`/gaming <date> <time> [game]` - Post a planned session in the gaming channel. Dates: today, tomorrow, a weekday, or DD/MM/YYYY. Times are UK time, e.g. 21:00 or 9pm. Game is optional from v1.9
`/games remove <game>` - Remove a game from the saved list *(privileged role only)*

**v1.5 - Quotes**
--------------------
`/quote <text>` - Save a quote. Botdog asks who said it, then posts it in the quotes channel
`/quotes <who>` - Show someone's last 3 quotes
Right-click a message > **Apps > Save as quote** - Post that message as a quote, credited to whoever wrote it

**v1.6 - Co-op games**
--------------------
`/coop set <game> <status>` - Set a game's co-op status: Ready, Not Purchased, Parked or Completed It Mate. New games are added to the list
`/coop recommend` - Pick a random Ready game to play
`/coop list [status]` - Show the co-op list by status (only you see it)

**v1.7 - Co-op list post**
--------------------
No new commands. The Co-op Gaming channel now always shows the latest co-op list, updated whenever a game's status changes

**v1.8 - Self-updating command list**
--------------------
No new commands. This list now reposts itself here whenever a new version is released

**v1.9 - Optional game for sessions**
--------------------
`/gaming <date> <time>` - Leave out the game to plan a session for a time before deciding what to play. The post says the game is to be decided
