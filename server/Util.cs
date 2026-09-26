// Armagetron Advanced, browser port. Copyright (C) 2026 Andreas Nägeli.
// Based on Armagetron Advanced, Copyright (C) Manuel Moos and the Armagetron Advanced team.
// GNU GPL version 2 or later, see COPYING.txt. Source: https://github.com/Kaliumhexacyanoferrat/armagetron-advanced-browser

// Small helpers: JSON in and out of the socket, and cleaning up what browsers send.

using System.Security.Cryptography;

// JSON in and out of the socket. Outgoing messages are serialized once and the
// same bytes go to every client in a room; incoming ones are read as a
// JsonElement so each message type takes just the fields it needs.

public static class Json
{
    public static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        NumberHandling = JsonNumberHandling.AllowNamedFloatingPointLiterals
    };

    public static byte[] Encode(object message) => JsonSerializer.SerializeToUtf8Bytes<object>(message, Options);

    public static string Str(this JsonElement e, string name, string fallback = null)
    {
        if (e.ValueKind != JsonValueKind.Object || !e.TryGetProperty(name, out var p) || p.ValueKind != JsonValueKind.String) return fallback;

        try
        {
            return p.GetString();
        }
        catch (InvalidOperationException)
        {
            // an escaped lone surrogate: not text
            return fallback;
        }
    }

    public static int Int(this JsonElement e, string name, int fallback = 0)
        => e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var p) && p.ValueKind == JsonValueKind.Number && p.TryGetDouble(out var d) && double.IsFinite(d)
            ? (int)Math.Clamp(d, int.MinValue, int.MaxValue) : fallback;

    public static double Num(this JsonElement e, string name, double fallback = 0)
        => e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var p) && p.ValueKind == JsonValueKind.Number && p.TryGetDouble(out var d) && double.IsFinite(d) ? d : fallback;

    public static bool Bool(this JsonElement e, string name, bool fallback = false)
        => e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var p) ? p.ValueKind == JsonValueKind.True || (p.ValueKind != JsonValueKind.False && fallback) : fallback;
}


public static class Names
{
    public const int MaxName = 20;

    public const int MaxChat = 200;

    /// <summary>
    /// A player or server name: printable, trimmed, not too long. The original's
    /// colour codes (0xRRGGBB) are allowed in names and kept as they are.
    /// </summary>
    public static string Clean(string text, string fallback, int max = MaxName)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            return fallback;
        }

        // more than a full name in colour codes can never be kept: cut before any work
        var limit = max * 3 + 16;

        if (text.Length > limit)
        {
            text = text[..(char.IsHighSurrogate(text[limit - 1]) ? limit - 1 : limit)];
        }

        try
        {
            text = text.Normalize(NormalizationForm.FormC);
        }
        catch (ArgumentException)
        {
            // broken surrogates: they are dropped below
        }

        var sb = new StringBuilder(text.Length);

        for (var i = 0; i < text.Length; i++)
        {
            var c = text[i];

            if (char.IsSurrogate(c))
            {
                // a pair stays, a lone half goes
                if (char.IsHighSurrogate(c) && i + 1 < text.Length && char.IsLowSurrogate(text[i + 1]))
                {
                    sb.Append(c).Append(text[++i]);
                }

                continue;
            }

            if (char.IsControl(c) || c is '\u200b' or '\u200e' or '\u200f' or '\u202a' or '\u202b' or '\u202c' or '\u202d' or '\u202e' or '\ufeff')
            {
                continue;
            }

            if (char.IsWhiteSpace(c))
            {
                // one space at a time, none at the start
                if (sb.Length > 0 && sb[^1] != ' ') sb.Append(' ');
                continue;
            }

            sb.Append(c);
        }

        // the visible length counts, colour codes are extra (but capped too): one pass to find the cut
        int visible = 0, end = 0;

        for (var i = 0; i < sb.Length;)
        {
            var code = CodeLength(sb, i);
            var step = code > 0 ? code : char.IsHighSurrogate(sb[i]) && i + 1 < sb.Length ? 2 : 1;

            if (i + step > max * 3 || (code == 0 && visible + 1 > max)) break;

            if (code == 0) visible++;

            i += step;
            end = i;
        }

        var result = sb.ToString(0, end).Trim();

        return Visible(result).Trim().Length == 0 ? fallback : result;
    }

    /// <summary>The length of the colour code (0xRRGGBB or 0xRESETT) at i, or 0.</summary>
    private static int CodeLength(StringBuilder s, int i)
    {
        if (i + 8 > s.Length || s[i] != '0' || s[i + 1] != 'x') return 0;

        var reset = true;
        var hex = true;

        for (var k = 0; k < 6; k++)
        {
            var c = s[i + 2 + k];

            reset &= c == "RESETT"[k];
            hex &= char.IsAsciiHexDigit(c);
        }

        return reset || hex ? 8 : 0;
    }

    /// <summary>The text without colour codes, for length checks and comparisons.</summary>
    public static string Visible(string text)
        => System.Text.RegularExpressions.Regex.Replace(text ?? "", "0x([0-9a-fA-F]{6}|RESETT)", "");

    public static string Chat(string text) => Clean(text, "", MaxChat);

    public static (int, int, int) Color(int r, int g, int b)
    {
        r = Math.Clamp(r, 0, 15);
        g = Math.Clamp(g, 0, 15);
        b = Math.Clamp(b, 0, 15);

        // an almost black cycle is invisible on the floor; lift it like the original does
        if (r + g + b < 6)
        {
            r = Math.Max(r, 2);
            g = Math.Max(g, 2);
            b = Math.Max(b, 2);
        }

        return (r, g, b);
    }

    public static string Token(string text)
        => text != null && text.Length is >= 8 and <= 64 && text.All(char.IsAsciiLetterOrDigit) ? text : "";

    public static string RoomId()
    {
        const string alphabet = "abcdefghjkmnpqrstuvwxyz23456789";

        return string.Create(6, 0, (span, _) =>
        {
            for (var i = 0; i < span.Length; i++)
            {
                span[i] = alphabet[RandomNumberGenerator.GetInt32(alphabet.Length)];
            }
        });
    }

    public static string Secret() => RandomNumberGenerator.GetHexString(32, lowercase: true);

    /// <summary>Compares secrets without leaking how much of them matched.</summary>
    public static bool Same(string a, string b)
        => a != null && b != null && CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(a), Encoding.UTF8.GetBytes(b));
}
