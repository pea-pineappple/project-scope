namespace Shop.Billing
{
    public static class Invoice
    {
        public static decimal Total(decimal[] lines)
        {
            return Sum(lines) * 1.1m;
        }

        static decimal Sum(decimal[] xs)
        {
            decimal s = 0;
            foreach (var x in xs) s += x;
            return s;
        }
    }
}
