namespace Shop.Report
{
    public static class Summary
    {
        public static decimal Total(decimal[] lines)
        {
            return lines.Length;
        }
    }
}
