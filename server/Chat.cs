// Armagetron Advanced, browser port. Copyright (C) 2026 Andreas Nägeli.
// Based on Armagetron Advanced, Copyright (C) Manuel Moos and the Armagetron Advanced team.
// GNU GPL version 2 or later, see COPYING.txt. Source: https://github.com/Kaliumhexacyanoferrat/armagetron-advanced-browser

// Chat, chat commands and the owner's administration of a room.
//
// Lines look like the original's: the name in the player's colour, then the
// text in light yellow (0xffff7f). /me, /msg, /players and /help work as
// there; the owner also has /kick, /ban, /unban, /bans, /kill and /restart,
// and the same things from the admin panel in the browser.

public sealed partial class Room
{
    private const string ChatColor = "0xffff7f";

    private void OnChat(Player p, string raw)
    {
        var text = Names.Chat(raw);

        if (text.Length == 0) return;

        p.Chatting = false;
        _playersChanged = true;

        if (text.StartsWith('/'))
        {
            Command(p, text);
            return;
        }

        if (!SpamCheck(p, text)) return;

        Broadcast($"{p.Colored}{ChatColor}: {text}");
    }

    private void Tell(Player p, string text) => p.Client?.Send(new Message(text));

    private void Command(Player p, string text)
    {
        var space = text.IndexOf(' ');
        var cmd = (space < 0 ? text : text[..space]).ToLowerInvariant();
        var rest = space < 0 ? "" : text[(space + 1)..].Trim();

        switch (cmd)
        {
            case "/me":
                if (rest.Length > 0 && SpamCheck(p, rest))
                {
                    Broadcast($"0xffffff* {p.Colored}{ChatColor} {rest}0xffffff *");
                }
                return;

            case "/msg":
                PrivateMessage(p, rest);
                return;

            case "/players":
                foreach (var x in _players)
                {
                    var tags = (x.Admin ? " (admin)" : "") + (x.IsBot ? " (AI)" : "") + (x.Spectator ? " (spectator)" : "");
                    Tell(p, $"{x.Id}: {x.Colored}{tags}, {x.Score} points");
                }
                return;

            case "/spectate":
                ToggleSpectator(p, !p.WantsSpectator);
                return;

            case "/help":
                Tell(p, "0xffff7fChat commands: /me <action>, /msg <player> <text>, /players, /spectate");
                if (p.Admin)
                {
                    Tell(p, "0xffff7fAdministrator: /kick <player> [reason], /ban <player> [minutes] [reason], /unban <number>, /bans, /kill <player>, /restart, /bots <minimum players>");
                }
                return;

            case "/kick":
            case "/ban":
            case "/kill":
            {
                if (!RequireAdmin(p)) return;

                var (target, after) = Target(p, rest);

                if (target == null) return;

                if (cmd == "/kill")
                {
                    Smite(p, target);
                }
                else if (cmd == "/kick")
                {
                    Kick(p, target, after);
                }
                else
                {
                    var parts = after.Split(' ', 2);
                    var minutes = parts.Length > 0 && double.TryParse(parts[0], NumberStyles.Float, CultureInfo.InvariantCulture, out var mm) ? mm : 0;
                    var reason = minutes > 0 ? (parts.Length > 1 ? parts[1] : "") : after;

                    BanPlayer(p, target, minutes, reason);
                }
                return;
            }

            case "/unban":
                if (!RequireAdmin(p)) return;
                Unban(p, int.TryParse(rest, out var number) ? number : -1);
                return;

            case "/bans":
                if (!RequireAdmin(p)) return;
                ListBans(p);
                return;

            case "/restart":
                if (!RequireAdmin(p)) return;
                Restart(p);
                return;

            case "/bots":
                if (!RequireAdmin(p)) return;
                if (int.TryParse(rest, out var min))
                {
                    var s = Settings.Copy();
                    s.MinPlayers = Math.Clamp(min, 0, 12);
                    ChangeSettings(p, s);
                }
                return;

            default:
                Tell(p, $"Unknown chat command \"{cmd}\".");
                return;
        }
    }

    private bool RequireAdmin(Player p)
    {
        if (p.Admin) return true;

        Tell(p, "0xff7f7fOnly the administrator of this server can do that.");

        return false;
    }

    /// <summary>FindPlayerByName: a part of the name, or an id.</summary>
    private (Player, string) Target(Player p, string rest)
    {
        if (rest.Length == 0)
        {
            Tell(p, "That command requires a player name as additional parameter.");
            return (null, "");
        }

        // the longest prefix of the arguments that names exactly one player
        var words = rest.Split(' ');

        for (var n = words.Length; n >= 1; n--)
        {
            var term = string.Join(' ', words[..n]);
            var after = string.Join(' ', words[n..]);

            if (int.TryParse(term, out var id) && _players.FirstOrDefault(x => x.Id == id) is { } byId)
            {
                return (byId, after);
            }

            var exact = _players.Where(x => string.Equals(Names.Visible(x.Name), term, StringComparison.OrdinalIgnoreCase)).ToList();

            if (exact.Count == 1) return (exact[0], after);

            var matches = _players.Where(x => Names.Visible(x.Name).Contains(term, StringComparison.OrdinalIgnoreCase)).ToList();

            if (matches.Count == 1) return (matches[0], after);

            if (matches.Count > 1 && n == 1)
            {
                Tell(p, $"0xff0000Too many matches found for the search term {term}. Be more specific.");
                return (null, "");
            }
        }

        Tell(p, $"0xff0000No matches were found that contained {words[0]}.");

        return (null, "");
    }

    private void PrivateMessage(Player p, string rest)
    {
        var (target, text) = Target(p, rest);

        if (target == null || text.Length == 0) return;

        if (!SpamCheck(p, text)) return;

        var line = $"{p.Colored}{ChatColor} --> {target.Colored}{ChatColor}: {text}";

        Tell(p, line);

        if (target != p) Tell(target, line);
    }

    /// <summary>
    /// nSpamProtection: every message fills a bucket that empties by one every
    /// 1.2 s; above 6 you are silenced, and whoever keeps at it is kicked.
    /// </summary>
    private bool SpamCheck(Player p, string text)
    {
        const double timeScale = 1.2;

        p.SpamLevel = Math.Max(0, p.SpamLevel - (_now - p.SpamTime) / timeScale);
        p.SpamTime = _now;

        if (text == p.LastChat && _now - p.LastChatTime < 5)
        {
            Tell(p, $"SPAM PROTECTION: you already said: {text}");
            return false;
        }

        var colors = System.Text.RegularExpressions.Regex.Matches(text, "0x[0-9a-fA-F]{6}").Count;

        p.SpamLevel += (1 + Math.Min(text.Length / 20.0, 4)) * Math.Log2(2 + colors);

        if (p.SpamLevel > 6)
        {
            p.SpamWarnings++;

            if (p.SpamLevel > 14 && p.SpamWarnings >= 3 && !p.Admin)
            {
                Kick(null, p, "You have been auto-kicked for spamming. You chatted too much.");
                return false;
            }

            Tell(p, $"SPAM PROTECTION: you are silenced for the next {Math.Ceiling((p.SpamLevel - 6) * timeScale)} seconds.");
            return false;
        }

        p.SpamWarnings = 0;
        p.LastChat = text;
        p.LastChatTime = _now;

        return true;
    }

    private void ToggleSpectator(Player p, bool on)
    {
        if (p.IsBot || p.WantsSpectator == on) return;

        if (!on && Humans.Count(x => !x.WantsSpectator) >= Settings.MaxPlayers)
        {
            Tell(p, "0xff7f7fThe server is full; you can play as soon as a place is free.");
            return;
        }

        p.WantsSpectator = on;
        _playersChanged = true;

        Broadcast(on
            ? $"{p.Colored} switches to spectator mode and will stop playing the next round."
            : $"{p.Colored} leaves spectator mode and enters the game again.");

        // still in the countdown: straight onto the grid
        if (!on && _phase == Phase.Countdown)
        {
            p.Spectator = false;
            SpawnLate(p);
        }
    }

    // -----------------------------------------------------------------------
    // Administration

    private void OnAdmin(Player p, JsonElement m)
    {
        if (!RequireAdmin(p)) return;

        var target = _players.FirstOrDefault(x => x.Id == m.Int("id", -1));

        switch (m.Str("cmd"))
        {
            case "kick":
                if (target != null) Kick(p, target, Names.Chat(m.Str("reason")));
                break;

            case "ban":
                if (target != null) BanPlayer(p, target, m.Num("minutes"), Names.Chat(m.Str("reason")));
                break;

            case "kill":
                if (target != null) Smite(p, target);
                break;

            case "unban":
                Unban(p, m.Int("index", -1));
                break;

            case "bans":
                ListBans(p);
                break;

            case "restart":
                Restart(p);
                break;

            case "settings":
                if (m.TryGetProperty("settings", out var s))
                {
                    ChangeSettings(p, RoomSettings.From(s, Settings));
                }
                break;
        }
    }

    private void Kick(Player by, Player target, string reason)
    {
        if (target.IsBot)
        {
            if (by != null) Tell(by, "AI players come and go with the minimum number of players; change that in the settings.");
            return;
        }

        if (target.Admin && by != null)
        {
            Tell(by, "You cannot kick yourself.");
            return;
        }

        var client = target.Client;

        _kicked[client.Cid != "" ? client.Cid : client.Address] = _now + 60;
        _kicked[client.Address] = _now + 60;

        // out first: a quick rejoin must not be taken for this room's leaving
        Leave(target, $"{target.Colored} 0xff7f7fwas kicked.");

        client.Send(new Kicked(string.IsNullOrWhiteSpace(reason)
            ? "You have been kicked by the server administrator; please stay away."
            : reason));

        _log($"{Names.Visible(target.Name)} kicked from '{Settings.Name}' ({Id})");
    }

    private void BanPlayer(Player by, Player target, double minutes, string reason)
    {
        if (target.IsBot || target.Admin)
        {
            Tell(by, target.IsBot ? "AI players cannot be banned." : "You cannot ban yourself.");
            return;
        }

        var client = target.Client;
        var until = minutes > 0 ? _now + minutes * 60 : double.PositiveInfinity;

        _bans.Add(new Ban(Names.Visible(target.Name), client.Cid, client.Address, until));

        Leave(target, $"{target.Colored} 0xff7f7fwas banned.");

        client.Send(new Kicked(string.IsNullOrWhiteSpace(reason)
            ? "You have been banned from this server."
            : $"You have been banned from this server: {reason}"));

        _log($"{Names.Visible(target.Name)} banned from '{Settings.Name}' ({Id})");

        ListBans(by);
    }

    private void Unban(Player by, int index)
    {
        _bans.RemoveAll(b => b.Until < _now);

        if (index < 0 || index >= _bans.Count)
        {
            Tell(by, "There is no ban with that number. /bans lists them.");
            return;
        }

        var ban = _bans[index];
        _bans.RemoveAt(index);

        Tell(by, $"{ban.Name} may come back.");

        ListBans(by);
    }

    private void ListBans(Player by)
    {
        _bans.RemoveAll(b => b.Until < _now);

        by.Client?.Send(new BanList([.. _bans.Select((b, i) => new BanInfo(i, b.Name, double.IsPositiveInfinity(b.Until) ? -1 : Math.Ceiling((b.Until - _now) / 60)))]));
    }

    private void Smite(Player by, Player target)
    {
        if (target.Cycle is not { Alive: true }) return;

        var doom = target.Doom;
        target.Doom = null;

        Finalize(target, doom?.Time ?? _now, -1, true);

        Broadcast($"{target.Colored} 0xRESETTwas smitten by an administrator.");
    }

    private void Restart(Player by)
    {
        _newMatch = true;

        Broadcast($"{by.Colored} restarts the match.");

        if (Humans.Any(x => !x.WantsSpectator))
        {
            StartRound(_now);
        }
    }

    private void ChangeSettings(Player by, RoomSettings next)
    {
        var old = Settings;
        Settings = next;

        var changes = new List<string>();

        if (old.Name != next.Name) changes.Add($"name \"{next.Name}\"");
        if (old.Password != next.Password) changes.Add(next.Password == "" ? "no password" : "a password");
        if (old.MaxPlayers != next.MaxPlayers) changes.Add($"at most {next.MaxPlayers} players");
        if (old.MinPlayers != next.MinPlayers) changes.Add($"AI players fill up to {next.MinPlayers}");
        if (old.AiIq != next.AiIq) changes.Add($"AI strength {next.AiIq}");
        if (old.SizeFactor != next.SizeFactor) changes.Add($"arena size {next.SizeFactor}");
        if (old.SpeedFactor != next.SpeedFactor) changes.Add($"speed {next.SpeedFactor}");
        if (old.Rubber != next.Rubber) changes.Add($"rubber {next.Rubber}");
        if (old.WallsLength != next.WallsLength) changes.Add(next.WallsLength > 0 ? $"trails {next.WallsLength} m long" : "endless trails");
        if (old.WallsStayUp != next.WallsStayUp) changes.Add($"walls stay up {next.WallsStayUp} s");
        if (old.ScoreLimit != next.ScoreLimit) changes.Add($"score limit {next.ScoreLimit}");
        if (old.RoundLimit != next.RoundLimit) changes.Add($"{next.RoundLimit} rounds per match");

        if (changes.Count > 0)
        {
            Broadcast($"0xffff7fSettings changed: {string.Join(", ", changes)}. The rules change from the next round on.");
        }

        foreach (var p in _players.Where(x => x.Admin))
        {
            p.Client?.Send(new SettingsEvent(Settings.ToWire(true)));
        }

        foreach (var p in _players.Where(x => !x.Admin))
        {
            p.Client?.Send(new SettingsEvent(Settings.ToWire(false)));
        }

        UpdateInfo();
    }
}
