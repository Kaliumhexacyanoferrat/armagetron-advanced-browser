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
        => e.TryGetProperty(name, out var p) && p.ValueKind == JsonValueKind.String ? p.GetString() : fallback;

    public static int Int(this JsonElement e, string name, int fallback = 0)
        => e.TryGetProperty(name, out var p) && p.ValueKind == JsonValueKind.Number && p.TryGetDouble(out var d) && double.IsFinite(d)
            ? (int)Math.Clamp(d, int.MinValue, int.MaxValue) : fallback;

    public static double Num(this JsonElement e, string name, double fallback = 0)
        => e.TryGetProperty(name, out var p) && p.ValueKind == JsonValueKind.Number && p.TryGetDouble(out var d) && double.IsFinite(d) ? d : fallback;

    public static bool Bool(this JsonElement e, string name, bool fallback = false)
        => e.TryGetProperty(name, out var p) ? p.ValueKind == JsonValueKind.True || (p.ValueKind != JsonValueKind.False && fallback) : fallback;

    /// <summary>Rounds for the wire: positions do not need more than a few decimals.</summary>
    public static double R3(double v) => Math.Round(v, 3);
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

        var sb = new StringBuilder();

        foreach (var c in text.Normalize(NormalizationForm.FormC))
        {
            if (char.IsControl(c) || c is '​' or '‎' or '‏' or '‪' or '‫' or '‬' or '‭' or '‮' or '﻿')
            {
                continue;
            }

            sb.Append(char.IsWhiteSpace(c) ? ' ' : c);
        }

        var result = System.Text.RegularExpressions.Regex.Replace(sb.ToString(), " {2,}", " ").Trim();

        if (Visible(result).Length == 0)
        {
            return fallback;
        }

        // the visible length counts, colour codes are extra (but capped too)
        while (Visible(result).Length > max || result.Length > max * 3)
        {
            result = result[..^1];
        }

        return result.TrimEnd();
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
