using Shop.Billing;

namespace Shop
{
    public class App
    {
        public decimal Run(decimal[] lines)
        {
            return Invoice.Total(lines);
        }

        public decimal Count(decimal[] lines)
        {
            return Shop.Report.Summary.Total(lines);
        }
    }
}
